// Data access. All queries live here; routes and workers never write SQL.

import { randomUUID } from 'node:crypto';
import { query, one, tx } from './pool.mjs';

export const repo = {
  // ---- modules ----
  getModule: (id) => one('SELECT * FROM modules WHERE id=$1 AND enabled=TRUE', [id]),
  listModules: () => query('SELECT * FROM modules WHERE enabled=TRUE ORDER BY created_at'),
  upsertModule: (m) => one(
    `INSERT INTO modules (id,name,kind,module_dest,config,enabled)
     VALUES ($1,$2,$3,$4,$5,COALESCE($6,TRUE))
     ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, kind=EXCLUDED.kind, module_dest=EXCLUDED.module_dest, config=EXCLUDED.config, enabled=EXCLUDED.enabled
     RETURNING *`,
    [m.id, m.name, m.kind, m.moduleDest, m.config ?? {}, m.enabled],
  ),

  // ---- launch intents (idempotency lives here) ----
  findIntentByKey: (requestKey) => one('SELECT * FROM launch_intents WHERE request_key=$1', [requestKey]),
  getIntent: (id) => one('SELECT * FROM launch_intents WHERE id=$1', [id]),
  insertIntent: (i) => one(
    `INSERT INTO launch_intents (id,request_key,status,module_id,params,mint,message_b64,blockhash,last_valid_block_height,size_bytes,account_count,expires_at)
     VALUES ($1,$2,'prepared',$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (request_key) DO NOTHING
     RETURNING *`,
    [i.id, i.requestKey, i.moduleId, i.params, i.mint, i.messageB64, i.blockhash, i.lastValidBlockHeight, i.sizeBytes, i.accountCount, i.expiresAt],
  ),
  setIntentStatus: (id, status, patch = {}) => one(
    `UPDATE launch_intents SET status=$2, signature=COALESCE($3,signature), error=COALESCE($4,error), updated_at=now() WHERE id=$1 RETURNING *`,
    [id, status, patch.signature ?? null, patch.error ?? null],
  ),
  // Atomically claim an intent for confirmation so two /confirm calls can't both submit.
  claimIntentForConfirm: (id) => one(
    `UPDATE launch_intents SET status='confirming', updated_at=now()
     WHERE id=$1 AND status='prepared' RETURNING *`,
    [id],
  ),

  // ---- coins ----
  getCoinByMint: (mint) => one('SELECT * FROM coins WHERE mint=$1', [mint]),
  getCoin: (id) => one('SELECT * FROM coins WHERE id=$1', [id]),
  listLiveCoins: () => query("SELECT c.*, m.kind AS kind FROM coins c JOIN modules m ON m.id=c.module_id WHERE c.status='live' ORDER BY c.created_at"),
  insertCoin: (c) => one(
    `INSERT INTO coins (id,mint,name,symbol,uri,launch_wallet,sharing_config,sharing_vault,bonding_curve,module_id,module_dest,buyback_dest,launch_signature,launch_slot,intent_id,split_verified)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     ON CONFLICT (mint) DO NOTHING RETURNING *`,
    [c.id, c.mint, c.name, c.symbol, c.uri, c.launchWallet, c.sharingConfig, c.sharingVault, c.bondingCurve, c.moduleId, c.moduleDest, c.buybackDest, c.launchSignature, c.launchSlot, c.intentId, c.splitVerified],
  ),

  // ---- epochs ----
  openEpoch: (index, startedAt) => one(
    `INSERT INTO epochs (epoch_index,started_at,status) VALUES ($1,$2,'open')
     ON CONFLICT (epoch_index) DO NOTHING RETURNING *`,
    [index, startedAt],
  ),
  getEpoch: (index) => one('SELECT * FROM epochs WHERE epoch_index=$1', [index]),
  setEpochStatus: (index, status, patch = {}) => one(
    `UPDATE epochs SET status=$2, ended_at=COALESCE($3,ended_at), coins_processed=COALESCE($4,coins_processed), lamports_distributed=COALESCE($5,lamports_distributed) WHERE epoch_index=$1 RETURNING *`,
    [index, status, patch.endedAt ?? null, patch.coinsProcessed ?? null, patch.lamportsDistributed ?? null],
  ),
  // Claim a coin's slot in an epoch; returns null if already taken (idempotent worker).
  claimEpochDistribution: (epochIndex, coinId) => one(
    `INSERT INTO epoch_distributions (id,epoch_index,coin_id,status)
     VALUES ($1,$2,$3,'running')
     ON CONFLICT (epoch_index,coin_id) DO NOTHING RETURNING *`,
    [randomUUID(), epochIndex, coinId],
  ),
  finishEpochDistribution: (id, patch) => one(
    `UPDATE epoch_distributions SET distributed_lamports=$2, module_lamports=$3, buyback_lamports=$4, signature=$5, status=$6, error=$7 WHERE id=$1 RETURNING *`,
    [id, patch.distributed ?? 0, patch.module ?? 0, patch.buyback ?? 0, patch.signature ?? null, patch.status, patch.error ?? null],
  ),

  // ---- receipts ----
  insertReceipt: (r) => one(
    `INSERT INTO receipts (id,kind,coin_id,epoch_index,signature,slot,lamports,fee_lamports,payload,solscan_url)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [r.id ?? randomUUID(), r.kind, r.coinId ?? null, r.epochIndex ?? null, r.signature, r.slot ?? null, r.lamports ?? null, r.feeLamports ?? null, r.payload ?? {}, r.solscanUrl],
  ),
  listReceiptsForCoin: (coinId, limit = 50) => query('SELECT * FROM receipts WHERE coin_id=$1 ORDER BY created_at DESC LIMIT $2', [coinId, limit]),

  // ---- ALT ----
  upsertAlt: (a) => one(
    `INSERT INTO alt_tables (table_address,creator,entries,entry_count,active,refreshed_at)
     VALUES ($1,$2,$3,$4,TRUE,now())
     ON CONFLICT (table_address) DO UPDATE SET entries=EXCLUDED.entries, entry_count=EXCLUDED.entry_count, refreshed_at=now()
     RETURNING *`,
    [a.tableAddress, a.creator, a.entries, a.entryCount],
  ),

  tx,
};
