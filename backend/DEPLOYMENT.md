# FEES production deployment runbook

Deploys the backend that passed local integration (23/23). **This runbook does
NOT enable mainnet launches.** `LAUNCH_ENABLED` stays `false` and
`FEES_MINT_ADDRESS` stays `null` (unset) until you explicitly approve go-live.
The only mainnet write in these steps is creating the launch ALT (a one-time
lookup table, a few thousand lamports of rent) — clearly marked in §7.

Architecture: **three Node processes + Postgres + a mainnet RPC.**
```
Browser (usefees.com)
   │  (never sees API_TOKEN)
Lovable BFF / edge function  ──Bearer API_TOKEN──▶  API :8080  ──Bearer SIGNER_TOKEN──▶  Signer :8091 (127.0.0.1, holds keys)
                                                      │                                        ▲
                                                  Postgres                                     │
                                   Worker (hourly) ──────────────────────────────────────────┘
```
Everything below assumes **one Ubuntu 22.04 VPS** (e.g. Hetzner CPX21 or
DigitalOcean $12) with the signer bound to `127.0.0.1`, plus **managed Postgres**
and a **paid mainnet RPC**. A multi-host variant (signer on its own box) is in
§11.

---

## 1. Services to provision (exact)

| Need | Use | Plan / notes |
|---|---|---|
| Mainnet RPC | **Helius** (helius.dev) | A paid plan (Developer+). Free/public RPC will rate-limit and drop launches. URL: `https://mainnet.helius-rpc.com/?api-key=XXXX`. Enable a priority-fee/"Sender" tier for landing. Alternatives: Triton, QuickNode. |
| Postgres | **Neon** (neon.tech) or Supabase or RDS | One database `fees`. Get a pooled connection string with `sslmode=require`. |
| Compute | **1 VPS**, Ubuntu 22.04, 2 vCPU / 4 GB | Hetzner CPX21 (~€8/mo) or DigitalOcean. |
| TLS / domain | **Caddy** on the VPS + DNS for `api.usefees.com` | Auto Let's Encrypt. |
| Frontend | **usefees.com on Lovable** + a server-side proxy | See §8 — the browser must not hold `API_TOKEN`. |

---

## 2. Wallets & secrets (create once, on the signer host)

Generate three dedicated wallets. **Private keys live only on the signer host.**

```bash
# on the VPS, as root
sudo useradd --system --create-home fees-signer
sudo useradd --system --create-home fees-app
sudo mkdir -p /etc/fees/keys && sudo chown -R fees-signer:fees-signer /etc/fees/keys && sudo chmod 700 /etc/fees/keys

# install the solana CLI (for keygen only)
sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"

sudo -u fees-signer bash -c '
  solana-keygen new --no-bip39-passphrase -o /etc/fees/keys/launch.json
  solana-keygen new --no-bip39-passphrase -o /etc/fees/keys/crank.json
  chmod 600 /etc/fees/keys/*.json
  echo "LAUNCH_WALLET_PUBKEY=$(solana-keygen pubkey /etc/fees/keys/launch.json)"
  echo "CRANK_WALLET_PUBKEY=$(solana-keygen pubkey /etc/fees/keys/crank.json)"
'
```
- **Launch wallet**: the fixed FEES creator/launch wallet. Fund it (start small — a few SOL — top up as launches scale).
- **Crank wallet**: pays hourly distribution + ALT maintenance fees. Fund ~1–2 SOL; refill via monitoring.
- **Buyback dest** (`BUYBACK_DEST`): the 10% sink. For now just a wallet you control; its keypair is only needed **later** when you enable buyback. Generate its pubkey and record it.

Generate the two shared secrets:
```bash
openssl rand -hex 32   # -> SIGNER_TOKEN  (API/worker <-> signer)
openssl rand -hex 32   # -> API_TOKEN     (BFF <-> API)
```

Back up the three key files to an encrypted vault (age/1Password/KMS). Losing the
launch key means losing control of every coin's `set_creator` authority path.

---

## 3. Code + dependencies

```bash
sudo mkdir -p /opt/fees && sudo chown fees-app:fees-app /opt/fees
sudo -u fees-app git clone <your fees repo> /opt/fees            # or rsync the fees-phase0 tree
cd /opt/fees/backend
sudo -u fees-app npm ci --omit=dev                               # installs @solana/web3.js, express, pg
```
`../lib` (the E3-proven builders) must be present next to `backend/`, and the
repo's root `node_modules` must have `@solana/web3.js` (run `npm ci` at the repo
root too, or vendor `lib/` into `backend/` and update `src/phase0.mjs`).

---

## 4. Environment files

Copy the two templates and fill them in. **They are different on purpose** — the
signer file has key paths; the app file has none.

```bash
sudo mkdir -p /etc/fees
sudo install -o fees-signer -g fees-signer -m 600 backend/deploy/env.signer.example /etc/fees/signer.env
sudo install -o fees-app    -g fees-app    -m 600 backend/deploy/env.app.example    /etc/fees/app.env
sudo -u fees-signer editor /etc/fees/signer.env      # fill RPC, pubkeys, SIGNER_TOKEN, key paths
sudo -u fees-app    editor /etc/fees/app.env         # fill RPC, pubkeys, DATABASE_URL, tokens
```
`SIGNER_TOKEN` **must be identical** in both files. `LAUNCH_ENABLED=false` in
`app.env`. `CORS_ORIGINS` empty (browser routes through the BFF, §8).

### Env var reference

Signer host (`/etc/fees/signer.env`): `NODE_ENV`, `DB_DRIVER=memory`, `RPC_URL`,
`RPC_COMMITMENT`, `EXPECTED_GENESIS`, `CLUSTER`, `LAUNCH_WALLET_PUBKEY`,
`CRANK_WALLET_PUBKEY`, `BUYBACK_DEST`, `SIGNER_PORT`, `SIGNER_TOKEN`,
`LAUNCH_KEYPAIR_PATH`, `CRANK_KEYPAIR_PATH`. (`BUYBACK_KEYPAIR_PATH` later.)

App host (`/etc/fees/app.env`, API + worker): `NODE_ENV`, `DB_DRIVER=pg`,
`DATABASE_URL`, `RPC_URL`, `RPC_COMMITMENT`, `EXPECTED_GENESIS`, `CLUSTER`,
`LAUNCH_WALLET_PUBKEY`, `CRANK_WALLET_PUBKEY`, `BUYBACK_DEST`, `LAUNCH_ALT_ADDRESS`,
`SIGNER_MODE=http`, `SIGNER_URL`, `SIGNER_TOKEN`, `PORT`, `API_TOKEN`,
`CORS_ORIGINS`, `LAUNCH_ENABLED`, `DEFAULT_DEV_BUY_LAMPORTS`,
`MAX_DEV_BUY_LAMPORTS`, `LAUNCH_PRIORITY_FEE_MICROLAMPORTS`, `LAUNCH_CU_LIMIT`,
`LAUNCH_INTENT_TTL_SECONDS`, `LAUNCH_MAX_SUBMIT_ATTEMPTS`,
`LAUNCH_CONFIRM_TIMEOUT_MS`, `EPOCH_INTERVAL_MS`,
`EPOCH_MIN_DISTRIBUTABLE_LAMPORTS`, `SOLSCAN_BASE`, `BUYBACK_ENABLED=false`.

---

## 5. Database

```bash
cd /opt/fees/backend
sudo -u fees-app --preserve-env bash -c 'set -a; . /etc/fees/app.env; set +a; npm run migrate'
# seed the first module (the 90% destination for coins that pick it):
sudo -u fees-app --preserve-env bash -c 'set -a; . /etc/fees/app.env; set +a; SEED_MODULE_ID=hold-v1 SEED_MODULE_NAME="Hold" SEED_MODULE_KIND=passthrough SEED_MODULE_DEST=<a pubkey> node scripts/seed_module.mjs'
```

---

## 6. Install & start the three services

```bash
sudo cp backend/deploy/fees-signer.service backend/deploy/fees-api.service backend/deploy/fees-worker.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now fees-signer
curl -s -H "authorization: Bearer $SIGNER_TOKEN" http://127.0.0.1:8091/health   # -> {"ok":true,"launchWallet":...}
sudo systemctl enable --now fees-api fees-worker
sudo systemctl status fees-signer fees-api fees-worker --no-pager
```
The worker will log `LAUNCH_ENABLED=false: … crank signer will refuse to submit
writes` — expected until go-live.

TLS:
```bash
sudo apt install -y caddy
sudo cp backend/deploy/Caddyfile /etc/caddy/Caddyfile      # edit the domain
sudo systemctl reload caddy
curl -s https://api.usefees.com/health                      # -> {"ok":true,...}
```

---

## 7. Create the launch ALT (one-time mainnet write — infra, not a launch)

E3 only fits with the 22-entry creator ALT, so it must exist before any launch
and before preflight passes. This is a small rent cost paid by the **crank**
wallet (fund it first). It does **not** launch a coin.

```bash
cd /opt/fees/backend
sudo -u fees-app --preserve-env bash -c 'set -a; . /etc/fees/app.env; set +a; LAUNCH_ENABLED=true npm run init-alt'
# prints:  set LAUNCH_ALT_ADDRESS=<addr>
sudo -u fees-app sed -i "s|^LAUNCH_ALT_ADDRESS=.*|LAUNCH_ALT_ADDRESS=<addr>|" /etc/fees/app.env
sudo systemctl restart fees-api fees-worker
```
(The one-off `LAUNCH_ENABLED=true` applies only to that command; the service env
stays `false`.)

---

## 8. `npm run preflight`

Read-only go/no-go — writes nothing. Run it with `LAUNCH_ENABLED=true` so the
final gate check is green too (safe; it never submits):

```bash
cd /opt/fees/backend
sudo -u fees-app --preserve-env bash -c 'set -a; . /etc/fees/app.env; set +a; LAUNCH_ENABLED=true npm run preflight'
```
All must pass: economics locked 9000/1000 · `$FEES` not invented · RPC genesis
matches · Global readable · **ALT usable (22 entries)** · launch & crank wallets
funded · DB migrated · **signer reachable & launch wallet matches** · LAUNCH_ENABLED.
Fix any FAIL before go-live.

---

## 9. Connect usefees.com / Lovable to the API

**Do not put `API_TOKEN` in the browser.** Route the browser through a
server-side proxy (Lovable backend action, or a Supabase/Cloudflare edge
function) that holds `FEES_API_TOKEN` and forwards to `https://api.usefees.com`.

Proxy (pseudocode):
```js
// server-side only — token never reaches the client
const r = await fetch(`https://api.usefees.com${req.path}`, {
  method: req.method,
  headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.FEES_API_TOKEN}` },
  body: req.method === 'POST' ? JSON.stringify(req.body) : undefined,
});
```
If you truly must call the API from the browser, set `CORS_ORIGINS=https://usefees.com`
in `app.env` and accept that the token is exposed — not recommended.

Endpoints Lovable uses (see `README.md` "What Lovable calls" for exact shapes):
- `GET /modules`
- `POST /launch/prepare` `{requestKey, name, symbol, uri, moduleId, devBuyLamports}` → preview
- `POST /launch/confirm` `{launchId}` → `{status:'confirmed', signature, splitVerified, coin, solscan}`; may return **202** `{status:'pending', retryable:true}` — the client should retry `/launch/confirm` with the same `launchId`.
- `GET /coins`, `GET /coins/:mint`, `GET /coins/:mint/receipts`

Frontend flow: pick a module → generate one `requestKey` (UUID) and **reuse it
for retries** → prepare → show preview → confirm → poll receipts. While
`LAUNCH_ENABLED=false`, `/launch/*` returns **503** — the UI can gate the button
on `GET /ready`.

---

## 10. Wiring the real 10% buyback + burn (DO LATER, keep off now)

Today: `FEES_MINT_ADDRESS` is `null`, `BUYBACK_ENABLED=false`, no swap provider →
the module records that the 10% is accruing in `BUYBACK_DEST` and does nothing
else. Files are already in place: `src/modules/buybackBurn.mjs` (burn is real:
SPL `BurnChecked`, verified) and `src/modules/swap/jupiter.mjs` (SOL→$FEES quote
+ swap instructions, **untested**).

When `$FEES` ships, enable it in this order:
1. Set the real mint in **`lib/constants.mjs`**: `FEES_MINT_ADDRESS = '<the mint>'`. (Never guess it; never an env var.)
2. Create/fund the **buyback keypair** on the signer host; set `BUYBACK_KEYPAIR_PATH` in `signer.env`.
3. Add a **buyback-specific signer policy** (required — do not skip). A Jupiter swap routes through third-party AMM programs not on the crank allowlist. Do **not** widen that allowlist. Instead add a `signAndSubmitBuyback` path that authorizes by **net effect**: the buyback wallet's SOL may drop by at most the epoch's buyback lamports + a fee cap, the tx **must** contain the `$FEES` `BurnChecked` for the full received amount, and no token-account authority may change. (Spec is in the header of `src/modules/swap/jupiter.mjs`.)
4. Wire the provider: call `setSwapProvider(jupiterSwapProvider)` at worker startup, guarded by `BUYBACK_ENABLED && FEES_MINT_ADDRESS`.
5. Set `BUYBACK_ENABLED=true`, `BUYBACK_SLIPPAGE_BPS` (default 100).
6. **Canary**: run one buyback for a tiny amount on a coin you control, confirm on Solscan that SOL was spent, `$FEES` was received per the quote, and the supply dropped (burn). Only then leave it on.

Until step 1, the buyback path throws if ever called with a real mint and is a
no-op otherwise — it cannot run against an invented mint.

---

## 11. Go-live (only when you approve) & hardening

To enable launches: set `LAUNCH_ENABLED=true` in `/etc/fees/app.env` (and the
signer host if you gate there), `systemctl restart fees-api fees-worker`, then do
**one** launch with a small `DEFAULT_DEV_BUY_LAMPORTS`, watch `/coins/:mint`
(`splitVerified:true`) and Solscan, before opening it to users.

Hardening checklist:
- **Signer on its own host**: move `fees-signer` to a separate box with no public ingress; set `SIGNER_URL` to its private-network address, firewall `:8091` to the API/worker only, keep the shared `SIGNER_TOKEN`. Upgrade to KMS/HSM/Turnkey/Squads for the launch key.
- Firewall: expose only 443 (Caddy) publicly; 8080/8091/5432 stay private.
- Backups: enable managed-Postgres PITR. Alert on crank/launch wallet balance, signer `/health`, worker epoch closes, and any `launch_failed_onchain`.
- Rotate `API_TOKEN`/`SIGNER_TOKEN` on a schedule; they never touch the browser.

---

## Quick command index

```bash
# migrate / seed
npm run migrate
node scripts/seed_module.mjs
# infra
LAUNCH_ENABLED=true npm run init-alt
LAUNCH_ENABLED=true npm run preflight
# services
systemctl {status|restart|stop} fees-signer fees-api fees-worker
# health
curl -s https://api.usefees.com/health
curl -s https://api.usefees.com/ready
curl -s -H "authorization: Bearer $SIGNER_TOKEN" http://127.0.0.1:8091/health
```
