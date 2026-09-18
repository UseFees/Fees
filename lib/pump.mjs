// Pump / PumpSwap / Pump Fees instruction builders and account decoders.
//
// Every discriminator, account order, PDA seed and argument layout in this file
// was taken from the ON-CHAIN Anchor IDL accounts read in E1 on 2026-09-18
// (results/E1.json revision 2), not from the repository IDL, which E1 proved
// stale. Where the IDL was ambiguous the layout was confirmed against a live
// mainnet transaction; those places are marked LIVE-CONFIRMED with the tx.
//
// Dependency-free apart from @solana/web3.js. No Anchor client: hand-encoding
// keeps the account order visible and reviewable, which matters for E3, where
// the 64-account cap is the thing being measured.

import { PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js';
import { PUMP_PROGRAM_ID, PUMP_AMM_PROGRAM_ID, PUMP_FEES_PROGRAM_ID_UNVERIFIED } from './constants.mjs';

/* ---------- program ids ---------- */

export const PUMP = new PublicKey(PUMP_PROGRAM_ID);
export const AMM = new PublicKey(PUMP_AMM_PROGRAM_ID);
export const FEES = new PublicKey(PUMP_FEES_PROGRAM_ID_UNVERIFIED); // verified in E1
export const MAYHEM = new PublicKey('MAyhSmzXzV1pTf7LsNkrNwkWKTo4ougAJ1PPg47MD4e');
export const TOKEN_2022 = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
export const TOKEN = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
export const ATA_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
export const WSOL = new PublicKey('So11111111111111111111111111111111111111112');
export const SYSTEM = SystemProgram.programId;

/* ---------- discriminators (on-chain IDL, E1) ---------- */

export const DISC = {
  create_v2: [214, 144, 76, 236, 95, 139, 49, 180],
  buy_v2: [184, 23, 238, 97, 103, 197, 211, 61],
  sell_v2: [93, 246, 130, 60, 231, 233, 64, 178],
  collect_creator_fee: [20, 22, 86, 123, 198, 28, 219, 132],
  collect_creator_fee_v2: [207, 17, 138, 242, 4, 34, 19, 56],
  distribute_creator_fees_v2: [255, 203, 19, 79, 244, 68, 8, 159],
  init_user_volume_accumulator: [94, 6, 202, 115, 255, 96, 232, 183],
  create_fee_sharing_config: [195, 78, 86, 76, 111, 52, 251, 213],
  update_fee_shares_v2: [111, 251, 49, 6, 78, 78, 106, 18],
  reset_fee_sharing_config_v2: [169, 245, 17, 209, 94, 91, 248, 128],
  BondingCurve: [23, 183, 248, 55, 96, 216, 172, 96],
  SharingConfig: [216, 74, 9, 0, 56, 140, 93, 75],
};

/* ---------- error tables (on-chain IDL, E1) ---------- */

export const FEES_ERRORS = {
  6001: 'InvalidAdmin',
  6007: 'InvalidSharingConfig',
  6009: 'SharingConfigAdminRevoked',
  6010: 'NoShareholders',
  6011: 'TooManyShareholders',
  6012: 'DuplicateShareholder',
  6013: 'NotEnoughRemainingAccounts',
  6014: 'InvalidShareTotal',
  6016: 'NotAuthorized',
  6017: 'ZeroShareNotAllowed',
  6018: 'SharingConfigNotActive',
  6019: 'AmmAccountsRequiredForGraduatedCoin',
  6020: 'ShareholderAccountMismatch',
  6023: 'DeprecatedInstruction',
  6024: 'FeeSharesAlreadyUpdated',
};

export const PUMP_ERRORS = {
  6019: 'InvalidCreator',
  6030: 'CreatorShouldNotBeZero',
  6041: 'BuyNotEnoughSolToCoverFees',
  6049: 'CreatorMigratedToSharingConfig',
  6050: 'UnableToDistributeCreatorVaultMigratedToSharingConfig',
  6051: 'SharingConfigNotActive',
  6052: 'UnableToDistributeCreatorFeesToExecutableRecipient',
  6053: 'BondingCurveAndSharingConfigCreatorMismatch',
  6054: 'ShareholdersAndRemainingAccountsMismatch',
  6055: 'InvalidShareBps',
  6070: 'UnableToDistributeCreatorFeesToUninitializedAccount',
  6077: 'CreatorFeeNotConfigurable',
  6078: 'CreatorFeeBpsOutOfRange',
  6083: 'HolderRewardCreatorImmutable',
};

// Anchor framework error codes (anchor-lang error.rs). Any program built with
// Anchor returns these for failures that happen before the handler runs; they
// are not in the program's own IDL error list. 101 in particular means the
// 8-byte discriminator matched no instruction in the DEPLOYED binary.
export const ANCHOR_ERRORS = {
  100: 'InstructionMissing (Anchor: 8-byte instruction identifier not provided)',
  101: 'InstructionFallbackNotFound (Anchor: discriminator matches no instruction in the deployed program)',
  102: 'InstructionDidNotDeserialize (Anchor: instruction data failed to deserialize)',
  103: 'InstructionDidNotSerialize',
  2000: 'ConstraintMut', 2001: 'ConstraintHasOne', 2002: 'ConstraintSigner', 2003: 'ConstraintRaw', 2004: 'ConstraintOwner',
  2005: 'ConstraintRentExempt', 2006: 'ConstraintSeeds', 2007: 'ConstraintExecutable', 2012: 'ConstraintAddress',
  2014: 'ConstraintAssociatedInit', 2019: 'ConstraintSpace',
  3000: 'AccountDiscriminatorAlreadySet', 3001: 'AccountDiscriminatorNotFound', 3002: 'AccountDiscriminatorMismatch',
  3003: 'AccountDidNotDeserialize', 3004: 'AccountDidNotSerialize', 3005: 'AccountNotEnoughKeys', 3006: 'AccountNotMutable',
  3007: 'AccountOwnedByWrongProgram', 3010: 'AccountNotSigner', 3012: 'AccountNotInitialized', 3014: 'AccountDuplicateReallocs',
};

/* ---------- PDAs ---------- */

const pda = (seeds, program) => PublicKey.findProgramAddressSync(seeds, program)[0];
const S = (s) => Buffer.from(s);

export const pdas = {
  global: () => pda([S('global')], PUMP),
  mintAuthority: () => pda([S('mint-authority')], PUMP),
  bondingCurve: (mint) => pda([S('bonding-curve'), mint.toBuffer()], PUMP),
  creatorVault: (creator) => pda([S('creator-vault'), creator.toBuffer()], PUMP), // hyphen: pump
  eventAuthority: (program) => pda([S('__event_authority')], program),
  globalVolumeAccumulator: () => pda([S('global_volume_accumulator')], PUMP),
  userVolumeAccumulator: (user) => pda([S('user_volume_accumulator'), user.toBuffer()], PUMP),
  feeConfig: () => pda([S('fee_config'), PUMP.toBuffer()], FEES),
  sharingConfig: (mint) => pda([S('sharing-config'), mint.toBuffer()], FEES),
  ammCreatorVaultAuthority: (x) => pda([S('creator_vault'), x.toBuffer()], AMM), // underscore: amm
  mayhemGlobalParams: () => pda([S('global-params')], MAYHEM),
  mayhemSolVault: () => pda([S('sol-vault')], MAYHEM),
  mayhemState: (mint) => pda([S('mayhem-state'), mint.toBuffer()], MAYHEM),
  ata: (owner, mint, tokenProgram = TOKEN) => pda([owner.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()], ATA_PROGRAM),
};

// LIVE-CONFIRMED (2Hwzgos…QkqU6): mayhem_token_vault is the Token-2022 ATA of
// the mayhem sol_vault for the mint, not of mayhem_state.
export const mayhemTokenVault = (mint) => pdas.ata(pdas.mayhemSolVault(), mint, TOKEN_2022);

/* ---------- borsh-ish encoders ---------- */

const u8 = (n) => Buffer.from([n & 0xff]);
const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const str = (s) => { const d = Buffer.from(s, 'utf8'); const l = Buffer.alloc(4); l.writeUInt32LE(d.length); return Buffer.concat([l, d]); };
const key = (k) => k.toBuffer();
const disc = (name) => Buffer.from(DISC[name]);

/* ---------- account meta helpers ---------- */

const w = (pubkey, isSigner = false) => ({ pubkey, isSigner, isWritable: true });
const r = (pubkey, isSigner = false) => ({ pubkey, isSigner, isWritable: false });

/* ---------- instructions: pump ---------- */

// create_v2. LIVE-CONFIRMED (2Hwzgos…QkqU6, 322Qbi3…XQqj): real clients send
// creator(32) + is_mayhem_mode(1) + is_cashback_enabled(1) + creator_fee_bps(8)
// and OMIT is_holder_reward. OptionBool/OptionU64 are therefore "present if
// bytes remain" trailing args. sendHolderRewardFlag=false reproduces exactly
// what live clients send; true appends an explicit 0 byte.
export function ixCreateV2({ mint, user, creator, name, symbol, uri, isMayhemMode = false, isCashbackEnabled = false, creatorFeeBps = 0n, sendHolderRewardFlag = false, isHolderReward = false }) {
  const bondingCurve = pdas.bondingCurve(mint);
  const parts = [disc('create_v2'), str(name), str(symbol), str(uri), key(creator), u8(isMayhemMode ? 1 : 0), u8(isCashbackEnabled ? 1 : 0), u64(creatorFeeBps)];
  if (sendHolderRewardFlag) parts.push(u8(isHolderReward ? 1 : 0));
  return new TransactionInstruction({
    programId: PUMP,
    keys: [
      w(mint, true),
      r(pdas.mintAuthority()),
      w(bondingCurve),
      w(pdas.ata(bondingCurve, mint, TOKEN_2022)),
      r(pdas.global()),
      w(user, true),
      r(SYSTEM),
      r(TOKEN_2022),
      r(ATA_PROGRAM),
      w(MAYHEM),
      r(pdas.mayhemGlobalParams()),
      w(pdas.mayhemSolVault()),
      w(pdas.mayhemState(mint)),
      w(mayhemTokenVault(mint)),
      r(pdas.eventAuthority(PUMP)),
      r(PUMP),
    ],
    data: Buffer.concat(parts),
  });
}

// Shared tail for buy_v2 / sell_v2. `creator` must be bonding_curve.creator AT
// THE TIME OF THE TRADE — it changes to the sharing_config PDA once fee sharing
// is configured (pump error 6049 CreatorMigratedToSharingConfig).
function tradeKeys({ mint, user, creator, feeRecipient, buybackFeeRecipient, includeGlobalVolume }) {
  const bondingCurve = pdas.bondingCurve(mint);
  const creatorVault = pdas.creatorVault(creator);
  const uva = pdas.userVolumeAccumulator(user);
  const keys = [
    r(pdas.global()),
    r(mint),
    r(WSOL),
    r(TOKEN_2022),
    r(TOKEN),
    r(ATA_PROGRAM),
    w(feeRecipient),
    w(pdas.ata(feeRecipient, WSOL, TOKEN)),
    w(buybackFeeRecipient),
    w(pdas.ata(buybackFeeRecipient, WSOL, TOKEN)),
    w(bondingCurve),
    w(pdas.ata(bondingCurve, mint, TOKEN_2022)),
    w(pdas.ata(bondingCurve, WSOL, TOKEN)),
    w(user, true),
    w(pdas.ata(user, mint, TOKEN_2022)),
    w(pdas.ata(user, WSOL, TOKEN)),
    w(creatorVault),
    w(pdas.ata(creatorVault, WSOL, TOKEN)),
    r(pdas.sharingConfig(mint)),
  ];
  if (includeGlobalVolume) keys.push(r(pdas.globalVolumeAccumulator()));
  keys.push(
    w(uva),
    w(pdas.ata(uva, WSOL, TOKEN)),
    r(pdas.feeConfig()),
    r(FEES),
    r(SYSTEM),
    r(pdas.eventAuthority(PUMP)),
    r(PUMP),
  );
  return keys;
}

export function ixBuyV2({ mint, user, creator, feeRecipient, buybackFeeRecipient, amount, maxSolCost }) {
  return new TransactionInstruction({
    programId: PUMP,
    keys: tradeKeys({ mint, user, creator, feeRecipient, buybackFeeRecipient, includeGlobalVolume: true }), // 27 accounts
    data: Buffer.concat([disc('buy_v2'), u64(amount), u64(maxSolCost)]),
  });
}

export function ixSellV2({ mint, user, creator, feeRecipient, buybackFeeRecipient, amount, minSolOutput }) {
  return new TransactionInstruction({
    programId: PUMP,
    keys: tradeKeys({ mint, user, creator, feeRecipient, buybackFeeRecipient, includeGlobalVolume: false }), // 26 accounts
    data: Buffer.concat([disc('sell_v2'), u64(amount), u64(minSolOutput)]),
  });
}

export function ixInitUserVolumeAccumulator({ payer, user }) {
  return new TransactionInstruction({
    programId: PUMP,
    keys: [w(payer, true), r(user), w(pdas.userVolumeAccumulator(user)), r(SYSTEM), r(pdas.eventAuthority(PUMP)), r(PUMP)],
    data: disc('init_user_volume_accumulator'),
  });
}

// No signer anywhere. That is the property E2 step 5 proves empirically.
export function ixCollectCreatorFee({ creator }) {
  return new TransactionInstruction({
    programId: PUMP,
    keys: [w(creator), w(pdas.creatorVault(creator)), r(SYSTEM), r(pdas.eventAuthority(PUMP)), r(PUMP)],
    data: disc('collect_creator_fee'),
  });
}

export function ixCollectCreatorFeeV2({ creator, quoteMint = WSOL, quoteTokenProgram = TOKEN }) {
  const creatorVault = pdas.creatorVault(creator);
  return new TransactionInstruction({
    programId: PUMP,
    keys: [
      w(creator),
      w(pdas.ata(creator, quoteMint, quoteTokenProgram)),
      w(creatorVault),
      w(pdas.ata(creatorVault, quoteMint, quoteTokenProgram)),
      r(quoteMint),
      r(quoteTokenProgram),
      r(ATA_PROGRAM),
      r(SYSTEM),
      r(pdas.eventAuthority(PUMP)),
      r(PUMP),
    ],
    data: disc('collect_creator_fee_v2'),
  });
}

// Remaining accounts for every instruction that distributes creator fees
// (distribute_creator_fees_v2 directly; update_fee_shares_v2 and
// reset_fee_sharing_config_v2 via CPI). Layout and flags are the official
// SDK's, @pump-fun/pump-sdk@2.0.0 src/sdk.ts updateFeeSharesV2:
//
//   [...currentShareholders.map(pubkey => ({ pubkey, isWritable: true, isSigner: false })),
//    ...(quoteMint.equals(NATIVE_MINT) ? [] :
//        currentShareholders.map(pubkey => ({ pubkey: ata(quoteMint, pubkey), isWritable: true, isSigner: false })))]
//
// The list must be the CURRENT sharing_config.shareholders, in stored order
// (pump 6054 ShareholdersAndRemainingAccountsMismatch, fees 6013
// NotEnoughRemainingAccounts / 6020 ShareholderAccountMismatch). Right after
// create_fee_sharing_config that list is [(creator, 10000)].
export function remainingAccountsForDistribution(currentShareholders, quoteMint = WSOL, quoteTokenProgram = TOKEN) {
  if (!Array.isArray(currentShareholders)) {
    throw new Error('currentShareholders is required: the CURRENT sharing_config.shareholders addresses in stored order (E2 run 1 failed here with fees error 6013)');
  }
  const wallets = currentShareholders.map((pubkey) => ({ pubkey, isSigner: false, isWritable: true }));
  if (quoteMint.equals(WSOL)) return wallets;
  const atas = currentShareholders.map((pubkey) => ({ pubkey: pdas.ata(pubkey, quoteMint, quoteTokenProgram), isSigner: false, isWritable: true }));
  return [...wallets, ...atas];
}

// Shareholders go in remaining_accounts, in sharing_config order (pump errors
// 6054 ShareholdersAndRemainingAccountsMismatch, 6070 …UninitializedAccount).
export function ixDistributeCreatorFeesV2({ payer, mint, bondingCurveCreator, shareholders, initializeAta = false, quoteMint = WSOL, quoteTokenProgram = TOKEN }) {
  const creatorVault = pdas.creatorVault(bondingCurveCreator);
  return new TransactionInstruction({
    programId: PUMP,
    keys: [
      w(payer, true),
      r(mint),
      r(pdas.bondingCurve(mint)),
      r(pdas.sharingConfig(mint)),
      w(creatorVault),
      r(SYSTEM),
      r(pdas.eventAuthority(PUMP)),
      r(PUMP),
      w(pdas.ata(creatorVault, quoteMint, quoteTokenProgram)),
      r(quoteMint),
      r(quoteTokenProgram),
      r(ATA_PROGRAM),
      ...remainingAccountsForDistribution(shareholders, quoteMint, quoteTokenProgram),
    ],
    data: Buffer.concat([disc('distribute_creator_fees_v2'), u8(initializeAta ? 1 : 0)]),
  });
}

/* ---------- instructions: pump_fees ---------- */

// pool / pump_amm_program / pump_amm_event_authority are optional and only
// required for graduated coins (fees error 6019). E2 coins are pre-graduation.
export function ixCreateFeeSharingConfig({ payer, mint }) {
  return new TransactionInstruction({
    programId: FEES,
    keys: [
      r(pdas.eventAuthority(FEES)),
      r(FEES),
      w(payer, true),
      r(pdas.global()),
      r(mint),
      w(pdas.sharingConfig(mint)),
      r(SYSTEM),
      w(pdas.bondingCurve(mint)),
      r(PUMP),
      r(pdas.eventAuthority(PUMP)),
      // Optional trio, None for a pre-graduation coin. Anchor's convention for
      // an absent optional account is the executing program's own id.
      r(FEES),
      r(FEES),
      r(FEES),
    ],
    data: disc('create_fee_sharing_config'),
  });
}

export function encodeShareholders(shareholders) {
  const len = Buffer.alloc(4);
  len.writeUInt32LE(shareholders.length);
  return Buffer.concat([len, ...shareholders.map((s) => Buffer.concat([key(s.address), u16(s.shareBps)]))]);
}

function sharingAuthorityKeys({ authority, mint, quoteMint, tokenProgram }) {
  const sharingConfig = pdas.sharingConfig(mint);
  const pumpCreatorVault = pdas.creatorVault(sharingConfig);
  const ammVaultAuthority = pdas.ammCreatorVaultAuthority(sharingConfig);
  return [
    r(pdas.eventAuthority(FEES)),
    r(FEES),
    w(authority, true),
    r(pdas.global()),
    r(mint),
    w(sharingConfig),
    r(pdas.bondingCurve(mint)),
    w(pumpCreatorVault),
    w(pdas.ata(pumpCreatorVault, quoteMint, tokenProgram)),
    r(SYSTEM),
    r(PUMP),
    r(pdas.eventAuthority(PUMP)),
    r(AMM),
    r(pdas.eventAuthority(AMM)),
    r(quoteMint),
    r(tokenProgram),
    r(ATA_PROGRAM),
    w(ammVaultAuthority),
    w(pdas.ata(ammVaultAuthority, quoteMint, tokenProgram)),
  ];
}

// update_fee_shares_v2 first distributes whatever the vault holds to the
// CURRENT shareholders (CPI into distribute_creator_fees_v2), then writes the
// new list. `shareholders` is the new split; `currentShareholders` is what the
// config holds right now and becomes the remaining accounts. 19 fixed accounts
// + N remaining (+ N ATAs for a non-native quote).
export function ixUpdateFeeSharesV2({ authority, mint, shareholders, currentShareholders, quoteMint = WSOL, tokenProgram = TOKEN }) {
  return new TransactionInstruction({
    programId: FEES,
    keys: [
      ...sharingAuthorityKeys({ authority, mint, quoteMint, tokenProgram }), // 19 accounts
      ...remainingAccountsForDistribution(currentShareholders, quoteMint, tokenProgram),
    ],
    data: Buffer.concat([disc('update_fee_shares_v2'), encodeShareholders(shareholders)]),
  });
}

// new_admin is the first account. The E2 hypothesis under test is that passing
// the default pubkey here is what sets admin_revoked=true (seen live in E1);
// the IDL's revoke_fee_sharing_authority has an empty account list. It shares
// update_fee_shares_v2's distribute-first account set, so it takes the same
// remaining accounts; without them a 6013 would masquerade as a rejection.
export function ixResetFeeSharingConfigV2({ authority, mint, newAdmin, currentShareholders, quoteMint = WSOL, tokenProgram = TOKEN }) {
  return new TransactionInstruction({
    programId: FEES,
    keys: [
      r(newAdmin),
      ...sharingAuthorityKeys({ authority, mint, quoteMint, tokenProgram }), // 20 accounts
      ...remainingAccountsForDistribution(currentShareholders, quoteMint, tokenProgram),
    ],
    data: disc('reset_fee_sharing_config_v2'),
  });
}

/* ---------- instructions: associated token ---------- */

export function ixCreateAtaIdempotent({ payer, owner, mint, tokenProgram = TOKEN }) {
  return new TransactionInstruction({
    programId: ATA_PROGRAM,
    keys: [w(payer, true), w(pdas.ata(owner, mint, tokenProgram)), r(owner), r(mint), r(SYSTEM), r(tokenProgram)],
    data: Buffer.from([1]), // CreateIdempotent
  });
}

/* ---------- decoders ---------- */

export function decodeBondingCurve(data) {
  if (!data || data.length < 8 + 40 + 1 + 32) return null;
  if (!data.subarray(0, 8).equals(Buffer.from(DISC.BondingCurve))) return null;
  let o = 8;
  const U = () => { const v = data.readBigUInt64LE(o); o += 8; return v; };
  const B = () => data[o++] === 1;
  const K = () => { const k = new PublicKey(data.subarray(o, o + 32)); o += 32; return k; };
  const out = {
    virtualTokenReserves: U(), virtualQuoteReserves: U(), realTokenReserves: U(), realQuoteReserves: U(), tokenTotalSupply: U(),
    complete: B(), creator: K(),
  };
  if (data.length >= o + 1 + 1 + 32 + 8 + 1 + 1) {
    out.isMayhemMode = B(); out.isCashbackCoin = B(); out.quoteMint = K(); out.creatorFeeBps = U(); out.canEditCreatorFee = B(); out.isHolderReward = B();
  }
  return out;
}

export function decodeSharingConfig(data) {
  if (!data || !data.subarray(0, 8).equals(Buffer.from(DISC.SharingConfig))) return null;
  let o = 8;
  const bump = data[o++], version = data[o++], status = data[o++];
  const mint = new PublicKey(data.subarray(o, o + 32)); o += 32;
  const admin = new PublicKey(data.subarray(o, o + 32)); o += 32;
  const adminRevoked = data[o++] === 1;
  const n = data.readUInt32LE(o); o += 4;
  const shareholders = [];
  for (let i = 0; i < n; i++) {
    shareholders.push({ address: new PublicKey(data.subarray(o, o + 32)), shareBps: data.readUInt16LE(o + 32) });
    o += 34;
  }
  return { bump, version, status: status === 1 ? 'Active' : status === 0 ? 'Paused' : status, mint, admin, adminRevoked, shareholders, totalBps: shareholders.reduce((a, s) => a + s.shareBps, 0) };
}

// Only the Global fields E2 needs. Offsets verified in E1 (decode consumed
// exactly 1087 bytes of a 1087-byte account).
export function decodeGlobalPartial(data) {
  let o = 8;
  const initialized = data[o++] === 1;
  const authority = new PublicKey(data.subarray(o, o + 32)); o += 32;
  const feeRecipient = new PublicKey(data.subarray(o, o + 32)); o += 32;
  const initialVirtualTokenReserves = data.readBigUInt64LE(o); o += 8;
  const initialVirtualSolReserves = data.readBigUInt64LE(o); o += 8;
  o += 8 + 8; // initial_real_token_reserves, token_total_supply
  const feeBasisPoints = data.readBigUInt64LE(o); o += 8;
  o += 32 + 1 + 8; // withdraw_authority, enable_migrate, pool_migration_fee
  const creatorFeeBasisPoints = data.readBigUInt64LE(o); o += 8;
  const feeRecipients = []; for (let i = 0; i < 7; i++) { feeRecipients.push(new PublicKey(data.subarray(o, o + 32))); o += 32; }
  o += 32 + 32; // set_creator_authority, admin_set_creator_authority
  const createV2Enabled = data[o++] === 1;
  o += 32 + 32 + 1 + 32 * 7 + 1; // whitelist_pda, reserved_fee_recipient, mayhem_mode_enabled, reserved_fee_recipients, is_cashback_enabled
  const buybackFeeRecipients = []; for (let i = 0; i < 8; i++) { buybackFeeRecipients.push(new PublicKey(data.subarray(o, o + 32))); o += 32; }
  const buybackBasisPoints = data.readBigUInt64LE(o); o += 8;
  o += 8 + 32; // initial_virtual_quote_reserves, whitelisted_quote_mints[1]
  const creatorFeeConfigurable = data[o++] === 1;
  const maxConfigurableCreatorFeeBps = data.readBigUInt64LE(o); o += 8;
  let holderRewardClaimAuthority = null, isHolderRewardEnabled = null;
  if (data.length >= o + 33) { holderRewardClaimAuthority = new PublicKey(data.subarray(o, o + 32)); o += 32; isHolderRewardEnabled = data[o++] === 1; }
  return { initialized, authority, feeRecipient, feeRecipients, buybackFeeRecipients, initialVirtualTokenReserves, initialVirtualSolReserves, feeBasisPoints, creatorFeeBasisPoints, createV2Enabled, buybackBasisPoints, creatorFeeConfigurable, maxConfigurableCreatorFeeBps, holderRewardClaimAuthority, isHolderRewardEnabled, bytes: data.length };
}

// Constant-product quote for a buy: tokens out for `solIn` lamports before fees.
// Used only to size `amount`; max_sol_cost carries the slack.
export function quoteBuy(curve, solIn) {
  const s = BigInt(solIn);
  return (s * curve.virtualTokenReserves) / (curve.virtualQuoteReserves + s);
}
