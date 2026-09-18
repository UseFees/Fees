# Backend integration — 2026-09-18

Environment: local Solana validator cloned from current mainnet state.

```text
23/23 checks passed
INTEGRATION PASS
```

Verified: creator ALT 22 entries, module listing, prepare, 1076-byte tx, ALT compression, 9000/1000 split, split-before-buy, idempotency, confirmation, on-chain sharing state, admin revocation, no fee-escape window in test, duplicate protection, receipts, hourly 90/10 accounting.

Expected disabled behavior: FEES mint null, buyback disabled, swap provider unwired, buyback deferred rather than falsely reported as burned.

This was not a mainnet launch.
