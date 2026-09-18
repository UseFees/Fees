// The ONE boundary to Phase 0. Everything the backend uses from the verified
// harness is re-exported here, so E3 stays the single source of truth and a
// later move to a standalone repo means vendoring lib/ and changing only this
// file. Nothing in this file adds behaviour — it re-exports.
//
// Paths resolve to <repo>/lib from <repo>/backend/src. @solana/web3.js is
// resolved against <repo>/node_modules (where Phase 0 installed it) for the
// lib files, and against backend/node_modules for the backend's own imports.

export {
  MODULE_SHARE_BPS, FEES_SHARE_BPS, FEES_MINT_ADDRESS,
  LIMIT_TX_BYTES, LIMIT_ACCOUNTS_PER_TX, LIMIT_CU_PER_TX,
  PUMP_PROGRAM_ID, PUMP_AMM_PROGRAM_ID, PUMP_FEES_PROGRAM_ID_UNVERIFIED,
  PUMP_GLOBAL_ACCOUNT,
} from '../../lib/constants.mjs';

export {
  PUMP, AMM, FEES, MAYHEM, TOKEN, TOKEN_2022, ATA_PROGRAM, WSOL, SYSTEM,
  pdas, mayhemTokenVault,
  ixCreateV2, ixBuyV2, ixSellV2, ixInitUserVolumeAccumulator,
  ixCollectCreatorFee, ixCollectCreatorFeeV2, ixDistributeCreatorFeesV2,
  ixCreateFeeSharingConfig, ixUpdateFeeSharesV2, ixResetFeeSharingConfigV2,
  ixCreateAtaIdempotent, encodeShareholders, remainingAccountsForDistribution,
  decodeBondingCurve, decodeSharingConfig, decodeGlobalPartial, quoteBuy,
  FEES_ERRORS, PUMP_ERRORS, ANCHOR_ERRORS, DISC,
} from '../../lib/pump.mjs';

export {
  ORDERS, atomicLaunchInstructions, devBuyAmounts,
  lookupTableCandidates, lookupTableCandidatesForCreator, mintDerivedAccounts,
  accountSummary, projectV0Size,
} from '../../lib/compose.mjs';

export { buildV0, serializedSizeV0, measureSize, measureAccounts } from '../../lib/measure.mjs';

// The locked launch order (E3 CONDITIONAL PASS). Any deviation is a bug.
export const LAUNCH_ORDER = 'SHARES_THEN_BUY';
