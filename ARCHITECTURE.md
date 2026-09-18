# Architecture

FEES has five trust-relevant layers:
1. API
2. Launch builder
3. Signer service
4. Postgres repository
5. Hourly epoch worker

## Launch flow
`prepare → validate → confirm → sign/submit → on-chain verify → persist receipt`

## Signer boundary
Production uses `SIGNER_MODE=http`. The API and worker should not hold launch/crank private keys.

## Per-mint isolation
Pump creator fee vaults are creator-keyed, so FEES retains per-mint accounting and per-mint sharing configuration.

## Global buyback
The intended 10% buyback can be netted by quote mint while preserving per-mint accounting.
