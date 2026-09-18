# Production topology

Recommended:
`public HTTPS → API → Postgres`

`API/worker → private authenticated signer → Solana RPC`

The signer should not be internet-exposed.
