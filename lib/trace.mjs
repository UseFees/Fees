// Transaction tracer. Every E2+ transaction goes through here so that each one
// is recorded with exactly the fields the architecture requires: signature,
// size, account count, compute units, fee, accounts changed, balances before
// and after, and the exact instruction(s) used.
//
// Local-cluster only by construction: sendTraced refuses to run if the
// connection's genesis hash belongs to a public cluster.

import { VersionedTransaction } from '@solana/web3.js';
import { buildV0, measureSize, measureAccounts } from './measure.mjs';
import { ANCHOR_ERRORS } from './pump.mjs';

// Program error table first, then Anchor's framework codes, then unknown(n).
const nameOf = (table, code) => table[code] ?? ANCHOR_ERRORS[code] ?? `unknown(${code})`;

const PUBLIC_GENESIS = {
  '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d': 'mainnet-beta',
  'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG': 'devnet',
  '4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY': 'testnet',
};

export async function assertLocalCluster(connection) {
  const genesis = await connection.getGenesisHash();
  if (PUBLIC_GENESIS[genesis]) {
    throw new Error(`refusing to write: RPC is ${PUBLIC_GENESIS[genesis]} (genesis ${genesis}). E2 runs on a local cloned validator only.`);
  }
  return genesis;
}

export function customErrorCode(err) {
  // err is the RPC/simulation error object: { InstructionError: [ixIndex, { Custom: n }] }
  const ie = err?.InstructionError;
  if (!Array.isArray(ie)) return null;
  const [ixIndex, kind] = ie;
  if (kind && typeof kind === 'object' && 'Custom' in kind) return { ixIndex, code: kind.Custom };
  return { ixIndex, code: null, kind };
}

async function snapshot(connection, watch) {
  const out = {};
  for (const [label, pubkey] of Object.entries(watch)) {
    const info = await connection.getAccountInfo(pubkey, 'confirmed');
    out[label] = { address: pubkey.toBase58(), lamports: info?.lamports ?? 0, exists: Boolean(info), owner: info?.owner?.toBase58() ?? null, dataLen: info?.data?.length ?? 0 };
  }
  return out;
}

export function ixNames(instructions) {
  return instructions.map((ix) => ix.__name ?? `${ix.programId.toBase58().slice(0, 4)}…:${Buffer.from(ix.data.subarray(0, 8)).toString('hex')}`);
}

export function named(name, ix) {
  ix.__name = name;
  return ix;
}

// Send, confirm, then fetch the confirmed transaction so every measurement
// comes from what the ledger recorded rather than from what we submitted.
export async function sendTraced(connection, { label, payer, signers, instructions, watch = {}, expectFailure = false, expectedCode = null, errorTable = {}, submitOnUnexpectedSuccess = false, submitEvenIfFails = false, lookupTables = [] }) {
  await assertLocalCluster(connection);
  const before = await snapshot(connection, watch);
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  // Build UNSIGNED first and size it from the compiled message. Both
  // tx.sign() and simulate/send call MessageV0.serialize(), which throws
  // "encoding overruns Uint8Array" for any message over 1232 bytes, so an
  // over-size transaction must be measured and short-circuited here — before
  // it is signed. serializedSizeV0 never allocates the fixed buffer.
  const tx = buildV0(payer.publicKey, instructions, blockhash, lookupTables);
  const size = measureSize(tx);
  const accounts = measureAccounts(tx);
  const record = { label, instructions: ixNames(instructions), txSizeBytes: size.bytes, withinSizeLimit: size.withinLimit, accountCount: accounts.total, staticAccounts: accounts.static, lookupAccounts: accounts.fromLookupTables, withinAccountLimit: accounts.withinLimit };

  // An over-size transaction never reaches the runtime: the node rejects it
  // while decoding. For E3 that rejection IS the measurement, so it is
  // recorded, not thrown, and nothing is signed or sent.
  if (!size.withinLimit) {
    record.outcome = 'REJECTED_TOO_LARGE';
    record.error = `compiled v0 message is ${size.bytes} bytes, over the ${size.limit}-byte packet limit; not signed or submitted`;
    record.signature = null;
    record.simulation = { err: 'not simulated: over the 1232-byte packet limit', unitsConsumed: null, logsTail: [] };
    record.balancesBefore = before;
    record.balancesAfter = before;
    return record;
  }

  tx.sign(signers);

  let sim;
  try {
    sim = await connection.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed' });
  } catch (err) {
    if (/too large|PACKET_DATA_SIZE|exceeds.*1232/i.test(String(err.message))) {
      record.outcome = 'REJECTED_TOO_LARGE';
      record.error = String(err.message).split('\n')[0];
      record.signature = null;
      record.simulation = { err: 'not simulated: rejected by the RPC node before deserialisation', unitsConsumed: null, logsTail: [] };
      record.balancesBefore = before;
      record.balancesAfter = before;
      return record;
    }
    throw err;
  }
  record.simulation = { err: sim.value.err, unitsConsumed: sim.value.unitsConsumed ?? null, logsTail: (sim.value.logs ?? []).slice(-8) };

  if (expectFailure) {
    const ce = customErrorCode(sim.value.err);
    record.outcome = sim.value.err ? 'FAILED_AS_EXPECTED' : 'UNEXPECTED_SUCCESS';
    record.error = sim.value.err ?? null;
    record.errorCode = ce?.code ?? null;
    record.errorName = ce?.code != null ? nameOf(errorTable, ce.code) : null;
    record.expectedCode = expectedCode;
    record.expectedName = expectedCode != null ? (errorTable[expectedCode] ?? ANCHOR_ERRORS[expectedCode] ?? null) : null;
    record.matchedExpectation = sim.value.err ? (expectedCode == null || ce?.code === expectedCode) : false;
    record.signature = null;
    record.note = 'expected-failure cases are proven by simulation and are not submitted, so a surprising success cannot derail the run';
    if (sim.value.err && submitEvenIfFails) {
      // Atomicity proofs need the ledger, not the simulator: submit, let it
      // fail on chain, and let the caller verify that no state was created.
      const sig = await connection.sendTransaction(tx, { skipPreflight: true });
      await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed').catch(() => {});
      const got = await connection.getTransaction(sig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
      record.signature = sig;
      record.slot = got?.slot ?? null;
      record.fee = got?.meta?.fee ?? null;
      record.computeUnits = got?.meta?.computeUnitsConsumed ?? null;
      record.onChainErr = got?.meta?.err ?? null;
      record.outcome = got?.meta?.err ? 'FAILED_ON_CHAIN_AS_EXPECTED' : 'UNEXPECTED_SUCCESS_ON_CHAIN';
      record.note = 'submitted deliberately so the ledger records the failure; all-or-nothing is then checked by reading the accounts the transaction would have created';
    }
    if (!sim.value.err) {
      record.note = 'UNEXPECTED: the transaction that should have failed simulated successfully. Not submitted; simulation logs are the evidence.';
      if (submitOnUnexpectedSuccess) {
        // Hypothesis tests (e.g. reset-as-revocation) want the state change.
        const sig = await connection.sendTransaction(tx, { skipPreflight: true });
        await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
        record.signature = sig;
        record.note = 'Simulated successfully and was submitted because submitOnUnexpectedSuccess was set; state change is on the ledger.';
      }
    }
    record.balancesBefore = before;
    record.balancesAfter = await snapshot(connection, watch);
    return record;
  }

  if (sim.value.err) {
    const ce = customErrorCode(sim.value.err);
    const name = ce?.code != null ? nameOf(errorTable, ce.code) : '';
    const e = new Error(`${label}: simulation failed: ${JSON.stringify(sim.value.err)} ${name}\n${(sim.value.logs ?? []).slice(-12).join('\n')}`);
    e.record = { ...record, outcome: 'SIMULATION_FAILED', error: sim.value.err, errorCode: ce?.code ?? null, errorName: name || null, balancesBefore: before };
    throw e;
  }

  const sig = await connection.sendTransaction(tx, { skipPreflight: true });
  await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
  const got = await connection.getTransaction(sig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
  const meta = got?.meta;
  const keys = got?.transaction.message.staticAccountKeys ?? [];

  record.signature = sig;
  record.slot = got?.slot ?? null;
  record.fee = meta?.fee ?? null;
  record.computeUnits = meta?.computeUnitsConsumed ?? record.simulation.unitsConsumed;
  record.err = meta?.err ?? null;
  record.outcome = meta?.err ? 'FAILED_ON_CHAIN' : 'CONFIRMED';
  record.accountsChanged = keys
    .map((k, i) => ({ address: k.toBase58(), lamportsBefore: meta?.preBalances?.[i] ?? null, lamportsAfter: meta?.postBalances?.[i] ?? null }))
    .filter((a) => a.lamportsBefore !== a.lamportsAfter)
    .map((a) => ({ ...a, delta: a.lamportsAfter - a.lamportsBefore }));
  record.tokenBalancesChanged = diffTokenBalances(keys, meta?.preTokenBalances ?? [], meta?.postTokenBalances ?? []);
  record.balancesBefore = before;
  record.balancesAfter = await snapshot(connection, watch);
  record.logsTail = (meta?.logMessages ?? []).filter((l) => /Instruction:|consumed|Error|failed/.test(l)).slice(-12);
  return record;
}

function diffTokenBalances(keys, pre, post) {
  const byIdx = new Map();
  for (const p of pre) byIdx.set(p.accountIndex, { account: keys[p.accountIndex]?.toBase58(), mint: p.mint, owner: p.owner, before: p.uiTokenAmount.amount, after: '0' });
  for (const p of post) {
    const e = byIdx.get(p.accountIndex) ?? { account: keys[p.accountIndex]?.toBase58(), mint: p.mint, owner: p.owner, before: '0' };
    e.after = p.uiTokenAmount.amount;
    byIdx.set(p.accountIndex, e);
  }
  return [...byIdx.values()].filter((e) => e.before !== e.after).map((e) => ({ ...e, delta: (BigInt(e.after) - BigInt(e.before)).toString() }));
}

export async function lamports(connection, pubkey) {
  return (await connection.getAccountInfo(pubkey, 'confirmed'))?.lamports ?? 0;
}
