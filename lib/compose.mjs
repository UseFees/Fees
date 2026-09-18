// E3 composition: the atomic launch transaction and offline size/account
// projection. Everything here reuses the E2-proven builders in lib/pump.mjs;
// nothing new is encoded. The only new mechanics are ordering, the compute
// budget instruction, and an optional address lookup table for the accounts
// that are identical for every launch.

import { PublicKey, ComputeBudgetProgram, AddressLookupTableProgram } from '@solana/web3.js';
import {
  PUMP, AMM, FEES, MAYHEM, TOKEN, TOKEN_2022, ATA_PROGRAM, WSOL, SYSTEM, pdas, mayhemTokenVault,
  ixCreateV2, ixBuyV2, ixInitUserVolumeAccumulator, ixCreateFeeSharingConfig, ixUpdateFeeSharesV2, ixCreateAtaIdempotent, quoteBuy,
} from './pump.mjs';
import { LIMIT_TX_BYTES, LIMIT_ACCOUNTS_PER_TX, LIMIT_CU_PER_TX } from './constants.mjs';

const named = (name, ix) => { ix.__name = name; return ix; };

export const ORDERS = {
  // Split installed BEFORE the first trade: the dev buy's creator fee is the
  // first lamport to reach the sharing vault. No trade ever routes to the
  // creator's own vault. This is the window-free path.
  SHARES_THEN_BUY: 'create_v2 → ata → [init_uva] → create_fee_sharing_config → update_fee_shares_v2 → buy_v2',
  // The order in the E3 brief. Atomic, so nothing external can interleave,
  // but the dev buy executes while bonding_curve.creator is still the creator
  // wallet, so its creator fee lands in the creator's vault at 100 %.
  BUY_THEN_SHARES: 'create_v2 → ata → [init_uva] → buy_v2 → create_fee_sharing_config → update_fee_shares_v2',
};

// Quote the dev buy from the Global initial curve (the bonding curve does not
// exist yet when the transaction is built). 3 % under the quote so slippage
// never binds; max_sol_cost carries 15 % slack for protocol + creator fees.
export function devBuyAmounts(global, devBuyLamports) {
  const curve = { virtualTokenReserves: global.initialVirtualTokenReserves, virtualQuoteReserves: global.initialVirtualSolReserves };
  const solIn = BigInt(devBuyLamports);
  return { amount: (quoteBuy(curve, solIn) * 97n) / 100n, maxSolCost: (solIn * 115n) / 100n };
}

// The five (or six) instructions of the atomic launch, in the requested order.
// `creator` signs as user (create_v2), payer (create_fee_sharing_config),
// authority (update_fee_shares_v2) and user (buy_v2): one wallet, one launch.
// cuLimit = 0 omits the compute-budget instruction: the default budget is
// 200k CU per instruction (1.2M for six), and E2 measured the four pump
// instructions at ~370k combined, so the instruction only costs bytes here.
// Production will add one anyway for the priority fee (~40 bytes incl. the
// program id); E3 records the size without it and states that overhead.
export function atomicLaunchInstructions({ order, mint, creator, global, name, symbol, uri, devBuyLamports, shareholders, includeUvaInit = false, cuLimit = 0, sendHolderRewardFlag = false }) {
  const { amount, maxSolCost } = devBuyAmounts(global, devBuyLamports);
  const create = named('pump.create_v2', ixCreateV2({ mint, user: creator, creator, name, symbol, uri, sendHolderRewardFlag }));
  const ata = named('ata.create_idempotent(creator, mint, token2022)', ixCreateAtaIdempotent({ payer: creator, owner: creator, mint, tokenProgram: TOKEN_2022 }));
  const uva = includeUvaInit ? [named('pump.init_user_volume_accumulator', ixInitUserVolumeAccumulator({ payer: creator, user: creator }))] : [];
  const fsc = named('pump_fees.create_fee_sharing_config', ixCreateFeeSharingConfig({ payer: creator, mint }));
  // Right after create_fee_sharing_config the config holds [(creator, 10000)]
  // (E2 B5), so the remaining accounts for the update are exactly [creator].
  const upd = named('pump_fees.update_fee_shares_v2', ixUpdateFeeSharesV2({ authority: creator, mint, shareholders, currentShareholders: [creator] }));
  const buyAfterShares = named('pump.buy_v2', ixBuyV2({ mint, user: creator, creator: pdas.sharingConfig(mint), feeRecipient: global.feeRecipient, buybackFeeRecipient: global.buybackFeeRecipients[0], amount, maxSolCost }));
  const buyBeforeShares = named('pump.buy_v2', ixBuyV2({ mint, user: creator, creator, feeRecipient: global.feeRecipient, buybackFeeRecipient: global.buybackFeeRecipients[0], amount, maxSolCost }));
  const cu = cuLimit ? [named('compute_budget.set_compute_unit_limit', ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit }))] : [];

  let body;
  if (order === 'SHARES_THEN_BUY') body = [create, ata, ...uva, fsc, upd, buyAfterShares];
  else if (order === 'BUY_THEN_SHARES') body = [create, ata, ...uva, buyBeforeShares, fsc, upd];
  else throw new Error(`unknown order ${order}`);
  return { instructions: [...cu, ...body], devBuy: { amount, maxSolCost } };
}

// Accounts that are the same for every launch and never signers: candidates
// for a one-time address lookup table. Program ids are excluded on purpose —
// the runtime requires invoked program ids to be static keys.
export function lookupTableCandidates(global) {
  return [
    pdas.global(), pdas.mintAuthority(), pdas.globalVolumeAccumulator(), pdas.feeConfig(),
    pdas.eventAuthority(PUMP), pdas.eventAuthority(FEES), pdas.eventAuthority(AMM),
    pdas.mayhemGlobalParams(), pdas.mayhemSolVault(),
    global.feeRecipient, pdas.ata(global.feeRecipient, WSOL, TOKEN),
    global.buybackFeeRecipients[0], pdas.ata(global.buybackFeeRecipients[0], WSOL, TOKEN),
    WSOL,
  ];
}

/* ---------- offline projection ---------- */

const compactLen = (n) => (n < 0x80 ? 1 : n < 0x4000 ? 2 : 3);

// Unique account keys of a v0 message, with signer/writable flags merged the
// way the runtime does (a key that is a signer anywhere is a signer).
export function accountSummary(instructions, payer) {
  const map = new Map();
  const add = (k, signer, writable) => {
    const s = k.toBase58();
    const e = map.get(s) ?? { pubkey: k, signer: false, writable: false, program: false };
    e.signer ||= signer; e.writable ||= writable; map.set(s, e);
  };
  add(payer, true, true);
  for (const ix of instructions) {
    add(ix.programId, false, false); map.get(ix.programId.toBase58()).program = true;
    for (const m of ix.keys) add(m.pubkey, m.isSigner, m.isWritable);
  }
  const all = [...map.values()];
  return { all, signers: all.filter((a) => a.signer).length, programs: all.filter((a) => a.program).length, total: all.length };
}

// Serialized size of a signed v0 transaction with the given lookup coverage.
// lookupSet: Set<base58> of keys the table supplies (never signers/programs).
export function projectV0Size(instructions, payer, lookupSet = new Set()) {
  const { all, signers } = accountSummary(instructions, payer);
  const fromTable = all.filter((a) => lookupSet.has(a.pubkey.toBase58()) && !a.signer && !a.program);
  const staticKeys = all.length - fromTable.length;
  const w = fromTable.filter((a) => a.writable).length, r = fromTable.length - w;
  let msg = 1 + 3 + compactLen(staticKeys) + 32 * staticKeys + 32 + compactLen(instructions.length);
  for (const ix of instructions) msg += 1 + compactLen(ix.keys.length) + ix.keys.length + compactLen(ix.data.length) + ix.data.length;
  msg += compactLen(fromTable.length ? 1 : 0) + (fromTable.length ? 32 + compactLen(w) + w + compactLen(r) + r : 0);
  const bytes = compactLen(signers) + 64 * signers + msg;
  return { bytes, staticKeys, fromTable: fromTable.length, totalAccounts: all.length, signers, withinSize: bytes <= LIMIT_TX_BYTES, withinAccounts: all.length <= LIMIT_ACCOUNTS_PER_TX, limits: { LIMIT_TX_BYTES, LIMIT_ACCOUNTS_PER_TX, LIMIT_CU_PER_TX } };
}

// Maximal legal coverage for a launch service with a FIXED creator wallet:
// the invariants above plus the accounts that depend only on the creator, and
// the program accounts that are referenced but never invoked at the top level
// (CPI targets are ordinary account metas). Excluded, and therefore static:
// the two signers, the four invoked program ids (pump, pump_fees, associated
// token program, and compute budget if used) and every mint-derived account.
export function lookupTableCandidatesForCreator(global, creator) {
  const uva = pdas.userVolumeAccumulator(creator);
  return [
    ...lookupTableCandidates(global),
    SYSTEM, TOKEN, TOKEN_2022, MAYHEM, AMM,
    uva, pdas.ata(uva, WSOL, TOKEN), pdas.ata(creator, WSOL, TOKEN),
  ];
}

// The accounts that change with every launch. Used by the self-test to prove
// no lookup candidate is mint-derived.
export function mintDerivedAccounts(mint, creator) {
  const bc = pdas.bondingCurve(mint), sc = pdas.sharingConfig(mint), scv = pdas.creatorVault(sc), amv = pdas.ammCreatorVaultAuthority(sc);
  return [mint, bc, pdas.ata(bc, mint, TOKEN_2022), pdas.ata(bc, WSOL, TOKEN), pdas.mayhemState(mint), mayhemTokenVault(mint), sc, scv, pdas.ata(scv, WSOL, TOKEN), amv, pdas.ata(amv, WSOL, TOKEN), pdas.ata(creator, mint, TOKEN_2022)];
}

export const NOTE_PROGRAM_IDS_STATIC = 'invoked program ids must be static keys; they never come from a lookup table';
