# Errors and retries

Preserve the same `requestKey` across retries for one intended launch.

A confirmation timeout is not proof of failure. The backend can return pending/retryable state and recheck signature history.
