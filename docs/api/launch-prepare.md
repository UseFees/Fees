# POST /launch/prepare

Input: `requestKey`, `name`, `symbol`, `uri`, `moduleId`, `devBuyLamports`.

Preparation creates or returns an idempotent launch intent. It does not mean the launch is confirmed on-chain.
