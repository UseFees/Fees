# FEES backend (alpha)

Production launch backend built **around the E3-proven atomic launch path**. It
does not redesign Phase 0 — it imports the verified builders from `../lib`
through one boundary (`src/phase0.mjs`) and adds the production concerns: an API,
a Postgres store, signer separation, and an hourly epoch worker.

> This app lives beside the Phase 0 harness for now because that is the only
> connected folder. It is a **separate deployable** and should be extracted to
> its own repo (`fees-backend`) before mainnet — vendor `lib/` in and change
> only `src/phase0.mjs`. Nothing here modifies Phase 0.

## What is locked (from E3, do not change)

- Fixed FEES launch/creator wallet; one 22-entry per-creator Address Lookup Table.
- Launch order: `create_v2 → ATA → create_fee_sharing_config → update_fee_shares_v2(9000/1000) → buy_v2`. **The split is installed before the buy.**
- 90% module / 10% FEES, enforced on chain by `sharing_config`; **9000/1000 is fixed in code and the process refuses to start if reconfigured.**
- After launch, `bonding_curve.creator = sharing_config` and `admin_revoked = true` — verified on `/launch/confirm`.
- `$FEES` is **not invented**: `FEES_MINT_ADDRESS` stays `null`; the buyback module refuses to act until it exists.

## Reality check before you flip it on

E0–E3 verified the path on a **local mainnet clone**. No coin has been launched
on real mainnet yet. This backend would perform the **first** real launch.
Before `LAUNCH_ENABLED=true`: fund and secure the launch wallet, run the signer
as a separate process, run `npm run preflight`, and do one launch with a small
`DEFAULT_DEV_BUY_LAMPORTS` and watch it on Solscan.

## Architecture

```
frontend ──HTTP(API_TOKEN)──▶  API (src/api)        holds NO keys, writes gated by LAUNCH_ENABLED
                                  │
                                  ├── Postgres (coins, launch_intents, receipts, epochs, modules, alt_tables)
                                  │
                                  └──HTTP(SIGNER_TOKEN)──▶ Signer (src/signer/service.mjs)   holds launch + crank keys
                                                                └ re-validates every tx against the locked invariants before signing

Epoch worker (src/epoch) ──hourly──▶ distribute_creator_fees_v2 via the crank signer ──▶ receipts
```

**Signer separation.** The API and DB never hold a private key. The signer runs
as its own process with `LAUNCH_KEYPAIR_PATH` / `CRANK_KEYPAIR_PATH`. It
independently deserializes every transaction, resolves ALT accounts, and refuses
to sign anything that isn't the exact locked launch path with the FEES-owned
buyback dest at 1000 bps and 9000/1000 total (`src/launch/validate.mjs`,
`src/signer/core.mjs`). The ephemeral per-launch mint keypair is generated and
kept **inside the signer** — it never touches the API or the DB.

## Files

```
src/phase0.mjs            the ONE import boundary to ../lib (E3 source of truth)
src/config.mjs            env + safety gates; 9000/1000 hard-locked here
src/solanaClient.mjs      shared Connection + genesis (wrong-cluster) guard
src/logger.mjs            JSON logs with secret redaction
src/launch/validate.mjs   locked-invariant validator (used by builder AND signer)
src/launch/alt.mjs        ALT create / load / refresh / readiness wait
src/launch/builder.mjs    production launch tx builder (ALT + priority fee + re-validation)
src/signer/keys.mjs       keypair-from-file (signer only)
src/signer/core.mjs       signing core: re-validate → sign → submit
src/signer/service.mjs    signer as a separate authenticated process
src/signer/index.mjs      signer client (http | inprocess)
src/db/pool.mjs, repo.mjs Postgres access
src/modules/executor.mjs  ModuleExecutor interface + registry (passthrough default)
src/modules/buybackModule.mjs  10% side; inert until $FEES exists
src/epoch/worker.mjs      hourly distribute + receipts + module hooks
src/receipts/solscan.mjs  Solscan links + receipt shaping
src/api/*                 server, middleware (auth/idempotency), routes
scripts/migrate.mjs       apply schema.sql
scripts/seed_module.mjs   create a module (a coin needs one)
scripts/init_alt.mjs      create/refresh the 22-entry launch ALT (once)
scripts/preflight.mjs     read-only go/no-go before enabling launches
schema.sql                Postgres schema
```

## Run locally (Ubuntu/WSL)

```bash
cd backend
npm install

# 1. Postgres (any instance). Example:
#    docker run -d --name fees-pg -e POSTGRES_USER=fees -e POSTGRES_PASSWORD=fees -e POSTGRES_DB=fees -p 5432:5432 postgres:16
cp .env.example .env            # fill in RPC_URL, wallet pubkeys, BUYBACK_DEST, DATABASE_URL, tokens
npm run migrate

# 2. Dedicated wallets (secrets OUTSIDE the repo; reuse Phase 0's tools/e2_keys.sh style)
#    Put their pubkeys in .env (LAUNCH_WALLET_PUBKEY, CRANK_WALLET_PUBKEY),
#    and the file paths in the SIGNER env (LAUNCH_KEYPAIR_PATH, CRANK_KEYPAIR_PATH).

# 3. Signer as a separate process (holds the keys)
SIGNER_MODE=http npm run signer          # terminal A, binds 127.0.0.1:8091

# 4. One-time ALT, then paste the printed LAUNCH_ALT_ADDRESS into .env
LAUNCH_ENABLED=true npm run init-alt

# 5. Seed a module (the 90% destination)
SEED_MODULE_DEST=<pubkey> npm run -s seed_module   # or: node scripts/seed_module.mjs

# 6. Preflight, then the API and worker
npm run preflight                         # all checks must pass
npm run api                               # terminal B  (8080)
npm run worker                            # terminal C  (hourly)
```

Nothing writes to chain until `LAUNCH_ENABLED=true`. For a dev machine without a
separate signer host you may set `SIGNER_MODE=inprocess` (the API then holds the
keys — dev only; the process logs a warning).

## What frontend calls

All under the API base URL, `Authorization: Bearer <API_TOKEN>`, JSON.

**1. List modules** — `GET /modules` → `{ modules: [{ id, name, kind, moduleDest, solscan }] }`

**2. Prepare a launch** — `POST /launch/prepare`
```json
{ "requestKey": "<idempotency key, >=8 chars, one per intended launch>",
  "name": "My Coin", "symbol": "MYC", "uri": "https://.../metadata.json",
  "moduleId": "hold-v1", "devBuyLamports": 500000000 }
```
→
```json
{ "launchId": "uuid", "status": "prepared", "mint": "<mint pubkey>",
  "sizeBytes": 1055, "sizeLimit": 1232, "accountCount": 38,
  "module": { "id": "hold-v1", "moduleDest": "…", "buybackDest": "…",
              "split": { "moduleBps": 9000, "feesBps": 1000 } },
  "launchOrder": ["create_v2","other","create_fsc","update_v2","buy_v2"],
  "preview": { "sharingConfig": "…", "sharingVault": "…", "devBuyLamports": "500000000" },
  "expiresAt": "…(90s)…" }
```
Re-sending the same `requestKey` returns the same intent (and the coin once
confirmed) with `"idempotent": true`. Nothing is signed yet.

**3. Confirm the launch** — `POST /launch/confirm`
```json
{ "launchId": "uuid" }
```
→
```json
{ "status": "confirmed", "launchId": "uuid", "signature": "<sig>",
  "splitVerified": true,
  "coin": { "mint": "…", "sharingConfig": "…", "moduleDest": "…", "buybackDest": "…",
            "split": { "moduleBps": 9000, "feesBps": 1000 }, "splitVerified": true,
            "solscan": { "token": "…", "tx": "…" } },
  "solscan": { "tx": "https://solscan.io/tx/…", "token": "https://solscan.io/token/…" } }
```
Idempotent: confirming an already-confirmed `launchId` returns the same result.
On failure it returns a 4xx/5xx with `{ error, code }` and the intent is marked
`failed` (a new `requestKey` starts a fresh attempt).

**4. Read coins / receipts**
- `GET /coins` → live coins
- `GET /coins/:mint` → one coin
- `GET /coins/:mint/receipts` → launch + hourly distribution receipts, each with a `solscan` link

**Health**: `GET /health`, `GET /ready` (unauthenticated).

### Suggested frontend flow
1. `GET /modules`, let the user pick.
2. Generate a `requestKey` (e.g. a UUID) **once** and keep it for retries.
3. `POST /launch/prepare` → show the preview (mint, split 90/10, dev buy, size).
4. On user confirm → `POST /launch/confirm` → show the Solscan links and `splitVerified`.
5. Poll `GET /coins/:mint/receipts` to show hourly distributions as they land.
