# Preflight

Preflight is a read-only go/no-go gate.

Verify cluster/genesis, required Pump state, configured wallets, ALT readiness, DB migration state, signer reachability/identity, locked economics, and deployment gates.

A failed preflight blocks canary.
