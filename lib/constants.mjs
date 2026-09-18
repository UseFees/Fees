// Program IDs and PDA seeds used by Phase 0.
// Every value here is UNVERIFIED until E1 confirms it from a live on-chain account.
// Nothing in this file may be copied into production code before E1 passes.

export const PUMP_PROGRAM_ID = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
export const PUMP_AMM_PROGRAM_ID = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';

// Documented but NOT confirmed from a live account. E1 resolves this by reading
// the owner of a real sharing_config account on mainnet.
export const PUMP_FEES_PROGRAM_ID_UNVERIFIED = 'pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ';

export const PUMP_GLOBAL_ACCOUNT = '4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf';

// Seed strings differ between the two programs. This is a real trap: the pump
// program uses a hyphen, pump-amm uses an underscore. A derivation bug here is
// silent and expensive, so both are named explicitly rather than shared.
export const SEED_CREATOR_VAULT_PUMP = 'creator-vault';
export const SEED_CREATOR_VAULT_AMM = 'creator_vault';
export const SEED_BONDING_CURVE = 'bonding-curve';
export const SEED_SHARING_CONFIG = 'sharing-config';
export const SEED_GLOBAL = 'global';

// FEES probe program seeds (E4, E8). Probe only; not production.
export const SEED_FEES_COIN = 'coin';
export const SEED_FEES_STEP = 'step';

// The mandatory split. Never parameterised, never configurable.
export const MODULE_SHARE_BPS = 9000;
export const FEES_SHARE_BPS = 1000;

// $FEES does not exist yet. This placeholder must never be replaced with a
// guessed address, and no buyback experiment may run while it is unset.
export const FEES_MINT_ADDRESS = null;

// Runtime limits measured against in E3 and E8.
export const LIMIT_TX_BYTES = 1232;
export const LIMIT_ACCOUNTS_PER_TX = 64;
export const LIMIT_CU_PER_TX = 1_400_000;
export const DEFAULT_CU_PER_IX = 200_000;
