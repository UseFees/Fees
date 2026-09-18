// Read-only production status probe. Sends no transactions and prints no secrets.
import { PublicKey } from '@solana/web3.js';
import { config } from '../src/config.mjs';
import { connection, assertCluster } from '../src/solanaClient.mjs';
import { FEES_MINT_ADDRESS } from '../src/phase0.mjs';
import { pool } from '../src/db/pool.mjs';

await assertCluster();
const conn = connection();

for (const [name, key] of [
  ['launch', config.launchWallet],
  ['crank', config.crankWallet],
  ['buyback', config.buybackDest],
]) {
  const lamports = await conn.getBalance(key, config.rpcCommitment);
  console.log(`${name}=${key.toBase58()} balance_sol=${(lamports / 1e9).toFixed(9)} lamports=${lamports}`);
}

if (FEES_MINT_ADDRESS) {
  const pk = new PublicKey(FEES_MINT_ADDRESS);
  const info = await conn.getAccountInfo(pk, config.rpcCommitment);
  if (!info) {
    console.log(`fees_mint=${FEES_MINT_ADDRESS} exists=false`);
  } else {
    let parsed = null;
    try { parsed = await conn.getParsedAccountInfo(pk, config.rpcCommitment); } catch {}
    const p = parsed?.value?.data?.parsed?.info ?? null;
    console.log(`fees_mint=${FEES_MINT_ADDRESS} exists=true owner=${info.owner.toBase58()} lamports=${info.lamports} executable=${info.executable} parsed_type=${parsed?.value?.data?.parsed?.type ?? 'unknown'} decimals=${p?.decimals ?? 'unknown'} supply=${p?.supply ?? 'unknown'} mintAuthority=${p?.mintAuthority ?? 'unknown'} freezeAuthority=${p?.freezeAuthority ?? 'unknown'}`);
  }
}

const candidateAlt = process.env.CANDIDATE_ALT_ADDRESS;
if (candidateAlt) {
  const altPk = new PublicKey(candidateAlt);
  const alt = await conn.getAddressLookupTable(altPk, { commitment: config.rpcCommitment });
  const table = alt.value;
  console.log(`candidate_alt=${candidateAlt} exists=${Boolean(table)} entry_count=${table?.state?.addresses?.length ?? 0} authority=${table?.state?.authority?.toBase58?.() ?? 'none'} last_extended_slot=${table?.state?.lastExtendedSlot ?? 'unknown'}`);
}

if (config.dbDriver === 'pg') {
  const r = await pool.query('SELECT table_address, creator, entry_count, active, created_at, refreshed_at FROM alt_tables ORDER BY created_at DESC LIMIT 10');
  console.log('alt_rows=' + JSON.stringify(r.rows));
}

await pool.end();
