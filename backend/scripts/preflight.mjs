// Read-only production preflight. Verifies config, cluster, wallets, ALT, DB,
// signer, and the locked economics — WITHOUT sending anything. Run before
// enabling launches.

import { config } from '../src/config.mjs';
import { assertCluster, connection } from '../src/solanaClient.mjs';
import { loadGlobal, loadAlt } from '../src/launch/alt.mjs';
import { pool } from '../src/db/pool.mjs';
import { MODULE_SHARE_BPS, FEES_SHARE_BPS, FEES_MINT_ADDRESS } from '../src/phase0.mjs';

const results = [];
const check = async (name, fn) => { try { const detail = await fn(); results.push({ name, ok: true, detail }); } catch (e) { results.push({ name, ok: false, detail: e.message }); } };

await check('economics locked 9000/1000', () => { if (MODULE_SHARE_BPS !== 9000 || FEES_SHARE_BPS !== 1000) throw new Error(`got ${MODULE_SHARE_BPS}/${FEES_SHARE_BPS}`); return '9000/1000'; });
await check('$FEES not invented', () => { if (FEES_MINT_ADDRESS) throw new Error(`FEES_MINT_ADDRESS is set to ${FEES_MINT_ADDRESS}; must stay null until $FEES ships`); return 'FEES_MINT_ADDRESS is null (correct)'; });
await check('RPC cluster matches EXPECTED_GENESIS', async () => { await assertCluster(); return config.expectedGenesis; });
await check('pump Global readable', async () => { const g = await loadGlobal(); return `create_v2_enabled=${g.createV2Enabled}, creator_fee_bps=${g.creatorFeeBasisPoints}`; });
await check('launch ALT usable (22 entries)', async () => { const g = await loadGlobal(); const alt = await loadAlt(g); if (!alt.ok) throw new Error(`not usable: ${alt.missing.join(', ')}`); return `${alt.entryCount} entries @ ${config.altAddress.toBase58()}`; });
await check('launch wallet funded', async () => { const bal = await connection().getBalance(config.launchWallet); if (bal < 100_000_000) throw new Error(`only ${bal} lamports; fund the launch wallet`); return `${(bal / 1e9).toFixed(3)} SOL`; });
await check('crank wallet funded', async () => { const bal = await connection().getBalance(config.crankWallet); if (bal < 10_000_000) throw new Error(`only ${bal} lamports`); return `${(bal / 1e9).toFixed(3)} SOL`; });
await check('database reachable + migrated', async () => { const r = await pool.query("SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name IN ('coins','launch_intents','receipts','modules','epochs','epoch_distributions','alt_tables')"); if (r.rows[0].n < 7) throw new Error(`only ${r.rows[0].n}/7 tables — run npm run migrate`); return 'all tables present'; });
await check('signer reachable', async () => { const res = await fetch(`${config.signer.url}/health`, { headers: { authorization: `Bearer ${config.signer.token ?? ''}` } }); if (!res.ok) throw new Error(`signer /health -> ${res.status}`); const j = await res.json(); if (j.launchWallet !== config.launchWallet.toBase58()) throw new Error(`signer launch wallet ${j.launchWallet} != config ${config.launchWallet.toBase58()}`); return `signer launch wallet matches`; });
await check('LAUNCH_ENABLED', () => { if (!config.launchEnabled) throw new Error('false — launches will 503 until set true'); return 'true'; });

for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `  — ${r.detail}` : ''}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
await pool.end();
process.exitCode = failed ? 1 : 0;
