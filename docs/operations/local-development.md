# Local development

Use local-only keypairs and the cloned local validator.

Never fund Phase 0 test keypairs on mainnet.

```bash
cd backend
npm ci
npm run check
npm run test:security
npm run test:confirm
```
