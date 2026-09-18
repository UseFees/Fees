# Idempotency

A caller-supplied `requestKey` identifies one intended launch.

The same key must map to the same launch intent and mint. Once confirmed, duplicate prepare/confirm calls return the existing result rather than creating a second launch.
