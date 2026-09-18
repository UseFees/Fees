# API overview

Primary endpoints:
- `GET /health`
- `GET /ready`
- `GET /modules`
- `POST /launch/prepare`
- `POST /launch/confirm`
- `GET /coins`
- `GET /coins/:mint`
- `GET /coins/:mint/receipts`

Browser clients should not receive private server bearer tokens.
