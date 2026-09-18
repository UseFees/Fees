// One-time creation of the fixed launch wallet's 22-entry Address Lookup Table.
// Run once, then set LAUNCH_ALT_ADDRESS to the printed address. Re-running
// detects an existing usable table and refreshes missing entries instead.
//
// The create/extend instructions are authored by the launch wallet, so they are
// signed by the launch SIGNER (the API host running this script never holds the
// key). Requires LAUNCH_ENABLED=true and a reachable signer.

import { config, assertWritable } from '../src/config.mjs';
import { assertCluster, connection, confirmSignature } from '../src/solanaClient.mjs';
import { signer } from '../src/signer/index.mjs';
import { buildV0 } from '../src/phase0.mjs';
import { loadGlobal, loadAlt, buildCreateAltInstructions, buildRefreshAltInstructions, waitAltReady } from '../src/launch/alt.mjs';
import { repo } from '../src/db/repo.mjs';
import { pool } from '../src/db/pool.mjs';

async function submit(instructions) {
  const { blockhash, lastValidBlockHeight } = await connection().getLatestBlockhash(config.rpcCommitment);
  const tx = buildV0(config.launchWallet, instructions, blockhash);
  const { signature } = await signer.signAndSubmitCrank({ messageBase64: Buffer.from(tx.message.serialize()).toString('base64') });
  await confirmSignature(signature, blockhash, lastValidBlockHeight);
  return signature;
}

async function main() {
  assertWritable();
  await assertCluster();
  const global = await loadGlobal();

  if (config.altAddress) {
    const alt = await loadAlt(global);
    if (alt.ok) { console.log(`ALT ${config.altAddress.toBase58()} already usable (${alt.entryCount} entries). Nothing to do.`); return; }
    const { instructions, missing } = await buildRefreshAltInstructions(global, alt.table);
    if (!instructions.length) { console.log('ALT present but reported not usable and nothing missing — inspect manually.'); return; }
    console.log(`refreshing ALT with ${missing.length} missing entries...`);
    const sig = await submit(instructions);
    await waitAltReady(config.altAddress, (await loadAlt(global)).entryCount, {});
    await repo.upsertAlt({ tableAddress: config.altAddress.toBase58(), creator: config.launchWallet.toBase58(), entries: missing, entryCount: missing.length });
    console.log(`refreshed. signature=${sig}`);
    return;
  }

  const { instructions, tableAddress, addresses } = await buildCreateAltInstructions(global);
  console.log(`creating ALT ${tableAddress.toBase58()} with ${addresses.length} entries (launch wallet ${config.launchWallet.toBase58()})...`);
  const sig = await submit(instructions);
  await waitAltReady(tableAddress, addresses.length, {});
  await repo.upsertAlt({ tableAddress: tableAddress.toBase58(), creator: config.launchWallet.toBase58(), entries: addresses.map((a) => a.toBase58()), entryCount: addresses.length });
  console.log('\n=== ALT created ===');
  console.log(`set LAUNCH_ALT_ADDRESS=${tableAddress.toBase58()}`);
  console.log(`create/extend signature: ${sig}`);
}

main().catch((e) => { console.error(e.message); process.exitCode = 1; }).finally(() => pool.end());
