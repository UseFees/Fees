# Contributing

Keep changes small and reviewable.

Before opening a PR:
- do not include secrets;
- do not weaken signer validation to make a test pass;
- preserve the 9000/1000 invariant unless explicitly changing protocol economics;
- update docs when behavior changes;
- add tests for security-sensitive behavior.

Run:
```bash
cd backend
npm ci
npm run check
npm run test:security
npm run test:confirm
```
