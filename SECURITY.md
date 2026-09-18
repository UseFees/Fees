# Security policy

## Reporting
Do not post private keys, seed phrases, bearer tokens, exploit payloads containing secrets, or private user data in public issues.

Use GitHub private security reporting if enabled. Otherwise request a private disclosure path through official project channels.

## High-impact areas
- signer authorization
- transaction substitution
- ALT substitution
- fee-share ordering
- duplicate/replay handling
- buyback swap authorization
- accounting/receipt divergence
- secret leakage

## Audit status
No third-party security audit is currently claimed.

## Key policy
Production private keys live outside the repository and should be readable only by the signer identity.
