# Fee routing

Pump creator fee vaults are keyed by creator pubkey rather than mint. FEES therefore treats per-mint segregation as an application invariant.

Each mint receives its own 9000/1000 sharing config. Epoch accounting remains attributable per mint even when execution can be netted by quote mint.
