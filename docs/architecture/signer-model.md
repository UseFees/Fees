# Signer model

Production target: `SIGNER_MODE=http`.

The signer loads keys outside the repo, resolves ALT accounts, independently validates the transaction, signs only after policy checks, submits, and returns the exact confirmation tuple.

The API and worker should not contain production private keys.
