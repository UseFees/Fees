// The locked-invariant validator. This is the security-critical heart of the
// launch path: it is run by the builder AND independently by the signer before
// it signs, so a compromised or buggy API cannot get a launch signed that
// deviates from the E3-proven, economics-locked path.
//
// It checks the transaction the signer is about to sign, from the instructions
// alone — no trust in labels or metadata.

import {
  PUMP, FEES, pdas, DISC, MODULE_SHARE_BPS, FEES_SHARE_BPS,
  LIMIT_TX_BYTES, LIMIT_ACCOUNTS_PER_TX,
} from '../phase0.mjs';

const b58 = (k) => k.toBase58();
const eqDisc = (data, name) => data.length >= 8 && Buffer.from(data.subarray(0, 8)).equals(Buffer.from(DISC[name]));

// Decode the shareholders vec that update_fee_shares_v2 carries, exactly as
// lib/pump.mjs encodes it: 8 disc + u32 len + N*(32 pubkey + u16 bps). Raw
// bytes only, so no PublicKey construction is needed to compare.
function shareholderBytes(data) {
  const n = data.readUInt32LE(8);
  const out = [];
  let o = 12;
  for (let i = 0; i < n; i++) {
    out.push({ addr: Buffer.from(data.subarray(o, o + 32)), shareBps: data.readUInt16LE(o + 32) });
    o += 34;
  }
  return out;
}

// launchWallet, mint, moduleDest, buybackDest are PublicKey; instructions is the
// array from atomicLaunchInstructions (each a TransactionInstruction).
export function validateLaunchInstructions({ instructions, launchWallet, mint, moduleDest, buybackDest }) {
  const problems = [];
  const fail = (m) => problems.push(m);

  // Strip a leading compute-budget instruction if present (allowed, priced in).
  const CB = 'ComputeBudget111111111111111111111111111111';
  const body = instructions.filter((ix) => b58(ix.programId) !== CB);
  const names = body.map((ix) => {
    if (b58(ix.programId) === b58(PUMP) && eqDisc(ix.data, 'create_v2')) return 'create_v2';
    if (b58(ix.programId) === b58(PUMP) && eqDisc(ix.data, 'buy_v2')) return 'buy_v2';
    if (b58(ix.programId) === b58(PUMP) && eqDisc(ix.data, 'init_user_volume_accumulator')) return 'init_uva';
    if (b58(ix.programId) === b58(FEES) && eqDisc(ix.data, 'create_fee_sharing_config')) return 'create_fsc';
    if (b58(ix.programId) === b58(FEES) && eqDisc(ix.data, 'update_fee_shares_v2')) return 'update_v2';
    // ATA program create-idempotent
    return 'other';
  });

  const iCreate = names.indexOf('create_v2');
  const iFsc = names.indexOf('create_fsc');
  const iUpd = names.indexOf('update_v2');
  const iBuy = names.indexOf('buy_v2');

  // 1. all four required instructions present, exactly once
  for (const [n, i] of [['create_v2', iCreate], ['create_fsc', iFsc], ['update_v2', iUpd], ['buy_v2', iBuy]]) {
    if (i < 0) fail(`missing ${n}`);
    if (names.filter((x) => x === n).length > 1) fail(`duplicate ${n}`);
  }
  if (problems.length) return { ok: false, problems, order: names };

  // 2. locked order: create_v2 < create_fsc < update_v2 < buy_v2
  if (!(iCreate < iFsc && iFsc < iUpd && iUpd < iBuy)) {
    fail(`order violation (create_v2@${iCreate}, create_fsc@${iFsc}, update_v2@${iUpd}, buy_v2@${iBuy}); the split must be installed before the buy`);
  }

  // 3. create_v2 names the launch wallet as creator (arg pubkey after 3 strings)
  const createIx = body[iCreate];
  {
    let o = 8;
    for (let s = 0; s < 3; s++) { const len = createIx.data.readUInt32LE(o); o += 4 + len; }
    const creatorArg = Buffer.from(createIx.data.subarray(o, o + 32));
    if (!creatorArg.equals(launchWallet.toBuffer())) fail('create_v2 creator arg is not the fixed launch wallet');
    // account 0 is the mint (signer); account 5 is the user (launch wallet)
    if (!createIx.keys[0].pubkey.toBuffer().equals(mint.toBuffer())) fail('create_v2 account 0 is not the expected mint');
    if (!createIx.keys[5].pubkey.toBuffer().equals(launchWallet.toBuffer())) fail('create_v2 user is not the launch wallet');
  }

  // 4. update_fee_shares_v2 encodes EXACTLY 9000 module / 1000 buyback, total 10000
  {
    const shares = shareholderBytes(body[iUpd].data);
    if (shares.length !== 2) fail(`update_fee_shares_v2 must have exactly 2 shareholders, has ${shares.length}`);
    const total = shares.reduce((a, s) => a + s.shareBps, 0);
    if (total !== 10000) fail(`shares total ${total} bps, must be 10000`);
    const mod = shares.find((s) => s.addr.equals(moduleDest.toBuffer()));
    const buy = shares.find((s) => s.addr.equals(buybackDest.toBuffer()));
    if (!mod || mod.shareBps !== MODULE_SHARE_BPS) fail(`module dest must hold exactly ${MODULE_SHARE_BPS} bps`);
    if (!buy || buy.shareBps !== FEES_SHARE_BPS) fail(`buyback dest must hold exactly ${FEES_SHARE_BPS} bps`);
    // update authority (account index 2 in lib layout) is the launch wallet
    if (!body[iUpd].keys[2].pubkey.toBuffer().equals(launchWallet.toBuffer())) fail('update_fee_shares_v2 authority is not the launch wallet');
  }

  // 5. buy_v2 routes to the sharing_config creator vault (proves the split
  //    governs the coin the buy pays into) — account index 16 in lib layout.
  {
    const expectedVault = pdas.creatorVault(pdas.sharingConfig(mint));
    if (!body[iBuy].keys[16].pubkey.toBuffer().equals(expectedVault.toBuffer())) {
      fail('buy_v2 creator vault is not the sharing_config vault; the buy is not governed by the split');
    }
  }

  return { ok: problems.length === 0, problems, order: names };
}

export function validateCompiledSize({ sizeBytes, accountCount }) {
  const problems = [];
  if (sizeBytes > LIMIT_TX_BYTES) problems.push(`compiled tx is ${sizeBytes} bytes, over the ${LIMIT_TX_BYTES} limit`);
  if (accountCount > LIMIT_ACCOUNTS_PER_TX) problems.push(`compiled tx has ${accountCount} accounts, over the ${LIMIT_ACCOUNTS_PER_TX} limit`);
  return { ok: problems.length === 0, problems };
}
