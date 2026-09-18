# FEES

**Programmable creator fees on Solana.**

FEES is building a launch flow where creators choose what **90% of creator fees** do, while the remaining **10% is reserved for buying and permanently burning the main `$FEES` token**.

> **Current status:** pre-mainnet alpha. The verified launch path has passed a full local-mainnet-clone integration run. A real `$FEES` mint has not been provided, the buyback swap provider is not wired, and the first mainnet canary has not happened.

- Website: https://usefees.com
- X: https://x.com/UseFees
- Status: [STATUS.md](STATUS.md)
- Transparency: [TRANSPARENCY.md](TRANSPARENCY.md)
- Security: [SECURITY.md](SECURITY.md)
- Architecture: [ARCHITECTURE.md](ARCHITECTURE.md)
- Economics: [ECONOMICS.md](ECONOMICS.md)
- Verification evidence: [proofs/](proofs/)

## Locked economics

| Route | Share | Rule |
|---|---:|---|
| Selected module | 90% | Routed to the selected module |
| `$FEES` buyback + burn | 10% | Mandatory once real mint + production swap path are enabled |
| Extra protocol cut | 0% | No additional percentage |

## Verified launch invariant

`create_v2 → setup/ATA → create_fee_sharing_config → update_fee_shares_v2(9000/1000) → buy_v2`

The split is installed **before** the buy. After success, `bonding_curve.creator == sharing_config` and `admin_revoked == true` are verified on-chain.

## Latest verified result

On **2026-09-18**:
- **23/23 integration checks passed**
- **11/11 signer-security checks passed**
- **6/6 confirmation checks passed**
- transaction size: **1076 bytes**
- **38 accounts**
- 9000/1000 split verified
- duplicate protection + idempotent confirmation verified
- hourly 90/10 accounting verified
- buyback correctly stayed inert because `FEES_MINT_ADDRESS` is null

This was on a **local validator seeded from current mainnet state**, not a real mainnet launch.

## Repo map

- `backend/` — API, signer, launch confirmation, DB, epoch worker
- `lib/` — verified Solana/Pump composition boundary
- `docs/` — architecture, API, security, economics, operations, modules
- `proofs/` — internal verification evidence
- `audits/` — audit status, open risks, self-review
- `.github/` — CI, templates, ownership, dependency automation

## Not claimed

FEES does **not** currently claim:
- a real `$FEES` mint exists;
- buyback/burn is live on mainnet;
- all ten modules are live;
- a third-party audit is complete;
- a real mainnet launch is complete.

See [STATUS.md](STATUS.md).

## Development

```bash
cd backend
npm ci
npm run check
npm run test:security
npm run test:confirm
```

The full integration test additionally requires the cloned local validator and dedicated local-only test keypairs.

## License

ISC. See [LICENSE](LICENSE).
