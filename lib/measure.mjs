// Measurement helpers. Every experiment reports transaction size, account count
// and compute units, because E3 and E8 are expected to bind on the 64-account
// runtime cap before they bind on the 1232-byte message limit.

import { Connection, VersionedTransaction, TransactionMessage } from '@solana/web3.js';
import { LIMIT_TX_BYTES, LIMIT_ACCOUNTS_PER_TX, LIMIT_CU_PER_TX } from './constants.mjs';

export function rpc(url) {
  if (!url) throw new Error('no RPC endpoint configured');
  return new Connection(url, { commitment: 'confirmed' });
}

export function buildV0(payer, instructions, blockhash, lookupTables = []) {
  const msg = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message(lookupTables);
  return new VersionedTransaction(msg);
}

// compact-u16 (shortvec) encoded length, as the runtime uses for every
// vector length prefix in a message.
const compactU16Len = (n) => (n < 0x80 ? 1 : n < 0x4000 ? 2 : 3);

// Serialized byte length of a compiled v0 transaction, computed from the
// message components rather than by encoding into a buffer.
//
// The SDK's MessageV0.serialize() allocates a fixed new Uint8Array(1232) and
// throws "encoding overruns Uint8Array" for any message over the 1232-byte
// packet limit — exactly the over-limit transactions E3 exists to measure. So
// E3 must NOT call tx.serialize()/message.serialize() to size a transaction.
// This reproduces the same wire layout (signatures ‖ version ‖ header ‖
// static keys ‖ blockhash ‖ instructions ‖ address-table lookups) additively,
// so it returns the true size — above or below 1232 — and never throws. Its
// agreement with the SDK below the limit is asserted in tools/selftest_e3.mjs.
export function serializedSizeV0(tx) {
  const m = tx.message;
  const numSigners = m.header.numRequiredSignatures;
  const staticKeys = m.staticAccountKeys.length;
  const lookups = m.addressTableLookups ?? [];

  let message = 1 /* version prefix */ + 3 /* header */;
  message += compactU16Len(staticKeys) + 32 * staticKeys;
  message += 32; /* recentBlockhash */
  message += compactU16Len(m.compiledInstructions.length);
  for (const ix of m.compiledInstructions) {
    const dataLen = ix.data.length;
    message += 1 /* programIdIndex */
      + compactU16Len(ix.accountKeyIndexes.length) + ix.accountKeyIndexes.length
      + compactU16Len(dataLen) + dataLen;
  }
  message += compactU16Len(lookups.length);
  for (const l of lookups) {
    message += 32 /* table account key */
      + compactU16Len(l.writableIndexes.length) + l.writableIndexes.length
      + compactU16Len(l.readonlyIndexes.length) + l.readonlyIndexes.length;
  }

  const bytes = compactU16Len(numSigners) + 64 * numSigners + message;
  return bytes;
}

export function measureSize(tx) {
  const bytes = serializedSizeV0(tx);
  return { bytes, limit: LIMIT_TX_BYTES, withinLimit: bytes <= LIMIT_TX_BYTES };
}

export function measureAccounts(tx) {
  const keys = tx.message.staticAccountKeys.length;
  const lookups = (tx.message.addressTableLookups ?? []).reduce(
    (n, l) => n + l.writableIndexes.length + l.readonlyIndexes.length,
    0,
  );
  const total = keys + lookups;
  return {
    static: keys,
    fromLookupTables: lookups,
    total,
    limit: LIMIT_ACCOUNTS_PER_TX,
    withinLimit: total <= LIMIT_ACCOUNTS_PER_TX,
  };
}

export async function measureCompute(connection, tx) {
  const sim = await connection.simulateTransaction(tx, {
    sigVerify: false,
    replaceRecentBlockhash: true,
    commitment: 'confirmed',
  });
  return {
    unitsConsumed: sim.value.unitsConsumed ?? null,
    limit: LIMIT_CU_PER_TX,
    err: sim.value.err,
    logs: sim.value.logs ?? [],
    withinLimit: (sim.value.unitsConsumed ?? 0) <= LIMIT_CU_PER_TX,
  };
}

// Simulation is the gate, not a diagnostic. Compare the simulated balance
// deltas against what the experiment intended before anything is submitted.
export async function measureAll(connection, payer, instructions, lookupTables = []) {
  const { blockhash } = await connection.getLatestBlockhash('finalized');
  const tx = buildV0(payer, instructions, blockhash, lookupTables);
  return {
    tx,
    size: measureSize(tx),
    accounts: measureAccounts(tx),
    compute: await measureCompute(connection, tx),
  };
}
