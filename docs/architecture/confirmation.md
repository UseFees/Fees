# Confirmation model

Prepared blockhashes can expire before confirmation. The backend refreshes the blockhash at sign time and persists signature, blockhash, and last valid block height.

Timeout/expiry is handled as retryable state when appropriate rather than immediate fatal failure.
