# Current status

Last updated: **2026-09-18**

## Verified
- E1: pass.
- E2 rev5: pass.
- E3 rev5: conditional pass.
- Signer-security suite: **11/11 passed**.
- Confirmation suite: **6/6 passed**.
- Full backend integration: **23/23 passed** on a local validator cloned from current mainnet state.
- Atomic split-before-buy ordering verified.
- `bonding_curve.creator == sharing_config` verified.
- `admin_revoked === true` verified.
- Prepare/confirm idempotency and duplicate protection verified.
- Epoch accounting verified at 90/10.

## Not live yet
- No first mainnet launch canary.
- `FEES_MINT_ADDRESS` is null.
- Production swap provider not wired.
- Buyback-specific signer policy not production-enabled.
- Lottery unavailable.
- Runtime module availability is determined by `GET /modules`.

## Next gates
1. Production RPC + Postgres.
2. Isolated HTTP signer.
3. Fixed launch wallet + ready 22-entry ALT.
4. Real `$FEES` mint.
5. Buyback signer policy + swap provider.
6. Production preflight.
7. Tiny mainnet canary.
8. Manual verification.
9. Broader public enablement.
