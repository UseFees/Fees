# Buyback signer policy

A swap can touch third-party AMM programs, so buyback must use a constrained policy.

Required checks include bounded quote spend, exact FEES mint, required burn, no authority changes, and explicit fee/slippage caps.

This path is not yet production-enabled.
