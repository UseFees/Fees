# System overview

The API prepares intents, validates input, and persists state. Production signing is delegated to a separate authenticated signer service.

The worker handles hourly fee distribution and module execution. Postgres stores durable launch, coin, module, epoch, and receipt state.

The launch builder imports the Phase 0 verified composition through a narrow boundary.
