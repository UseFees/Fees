# Testing

## Fast checks
```bash
cd backend
npm run check
npm run test:security
npm run test:confirm
```

## Full integration
`npm run test:integration` requires the cloned local validator and local-only test keypairs.

Latest verified result: **23/23 checks passed** on 2026-09-18.

Covered: ALT compression, tx size, 9000/1000 split, split-before-buy order, idempotency, on-chain sharing state, immutable config, receipts, duplicate protection, epoch 90/10 accounting, and expected buyback disablement while the FEES mint is null.
