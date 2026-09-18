// Address Lookup Table lifecycle for the fixed launch wallet.
//
// E3 proved the launch fits (1055/1232 bytes) ONLY with the 22-entry
// per-creator table. This module creates that table once, loads it for every
// launch, and refreshes it if the on-chain Global's fee/buyback recipients ever
// change (they are part of the table).
//
// The table is authored by the launch wallet, so create/extend are signed by
// the launch signer. Reads are unsigned.

import { AddressLookupTableProgram } from '@solana/web3.js';
import { connection } from '../solanaClient.mjs';
import { config } from '../config.mjs';
import { lookupTableCandidatesForCreator, decodeGlobalPartial, pdas } from '../phase0.mjs';

export async function loadGlobal() {
  const info = await connection().getAccountInfo(pdas.global());
  if (!info) throw new Error('pump Global account not found on this RPC');
  return decodeGlobalPartial(info.data);
}

// The exact 22 addresses this launch wallet's table must hold.
export async function expectedAltEntries(global) {
  return lookupTableCandidatesForCreator(global, config.launchWallet);
}

// Fetch the configured table and verify it holds every expected entry. Returns
// { table, ok, missing[] }. `ok:false` means a launch would compile over-size.
export async function loadAlt(global) {
  if (!config.altAddress) return { table: null, ok: false, missing: ['LAUNCH_ALT_ADDRESS is not set'] };
  const res = await connection().getAddressLookupTable(config.altAddress, { commitment: config.rpcCommitment });
  const table = res.value;
  if (!table) return { table: null, ok: false, missing: ['table account not found'] };
  const have = new Set(table.state.addresses.map((a) => a.toBase58()));
  const want = await expectedAltEntries(global);
  const missing = want.filter((k) => !have.has(k.toBase58())).map((k) => k.toBase58());
  return { table, ok: missing.length === 0, missing, entryCount: table.state.addresses.length };
}

// The table is AUTHORED and paid by the crank wallet (a maintenance role), not
// the high-value launch wallet — the launch key then only ever signs launches.
// The table's authority is irrelevant to launches, which only read its
// addresses; its ENTRIES are still the launch wallet's derived accounts.
// scripts/init_alt.mjs routes these through the crank signer.
export async function buildCreateAltInstructions(global) {
  const recentSlot = await connection().getSlot('finalized');
  const [createIx, tableAddress] = AddressLookupTableProgram.createLookupTable({ authority: config.crankWallet, payer: config.crankWallet, recentSlot });
  const addresses = await expectedAltEntries(global);
  const extendIx = AddressLookupTableProgram.extendLookupTable({ payer: config.crankWallet, authority: config.crankWallet, lookupTable: tableAddress, addresses });
  return { instructions: [createIx, extendIx], tableAddress, addresses };
}

// Extend an existing table with any entries it is missing (refresh path).
export async function buildRefreshAltInstructions(global, table) {
  const have = new Set(table.state.addresses.map((a) => a.toBase58()));
  const want = await expectedAltEntries(global);
  const missing = want.filter((k) => !have.has(k.toBase58()));
  if (!missing.length) return { instructions: [], missing: [] };
  const extendIx = AddressLookupTableProgram.extendLookupTable({ payer: config.crankWallet, authority: config.crankWallet, lookupTable: config.altAddress, addresses: missing });
  return { instructions: [extendIx], missing: missing.map((k) => k.toBase58()) };
}

// Wait until a freshly created/extended table has all its addresses readable
// and is usable from a slot past its last extension. Compiling before this
// silently produces an uncompressed, over-size launch (the E3 rev2 bug).
export async function waitAltReady(tableAddress, expectedCount, { tries = 60, delayMs = 400 } = {}) {
  for (let i = 0; i < tries; i++) {
    const table = (await connection().getAddressLookupTable(tableAddress, { commitment: config.rpcCommitment })).value;
    const loaded = table?.state.addresses.length ?? 0;
    if (table && loaded >= expectedCount && table.state.lastExtendedSlot < (await connection().getSlot('confirmed'))) return table;
    await new Promise((r) => setTimeout(r, delayMs));
  }
  throw new Error(`lookup table ${tableAddress.toBase58()} not ready (need ${expectedCount} addresses)`);
}
