# Rollback and disable

Operational rollback means stopping new writes:
- disable launches;
- stop/gate worker execution if needed;
- preserve receipts and DB state;
- investigate before re-enabling.

Immutable on-chain sharing state cannot be rolled back like a DB row.
