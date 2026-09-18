# POST /launch/confirm

Input: `launchId`.

The server refreshes time-sensitive fields at sign time, signs/submits through the signer, and verifies on-chain state.

Possible outcomes: confirmed, pending/retryable, or failed.
