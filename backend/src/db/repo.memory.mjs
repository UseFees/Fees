// In-memory repository for the integration test and local dev. Mirrors the
// Postgres driver's method surface AND its conflict semantics (unique
// request_key, unique mint, unique (epoch, coin), single-confirm claim), so the
// idempotency and duplicate-launch tests exercise the same behaviour they would
// against Postgres. Not for production (no durability, no concurrency guarantees
// beyond a single process).

import { randomUUID } from 'node:crypto';

const modules = new Map();          // id -> module
const intents = new Map();          // id -> intent
const intentsByKey = new Map();     // request_key -> id
const coins = new Map();            // id -> coin
const coinsByMint = new Map();      // mint -> id
const epochs = new Map();           // epoch_index -> epoch
const epochDist = new Map();        // `${epoch}:${coin}` -> row
const receipts = [];                // append-only
const alts = new Map();

const clone = (o) => (o == null ? null : JSON.parse(JSON.stringify(o)));

export const repo = {
  // ---- modules ----
  async getModule(id) { const m = modules.get(id); return m && m.enabled ? clone(m) : null; },
  async listModules() { return [...modules.values()].filter((m) => m.enabled).map(clone); },
  async upsertModule(m) {
    const row = { id: m.id, name: m.name, kind: m.kind, module_dest: m.moduleDest, config: m.config ?? {}, enabled: m.enabled ?? true, created_at: modules.get(m.id)?.created_at ?? new Date().toISOString() };
    modules.set(m.id, row); return clone(row);
  },

  // ---- launch intents ----
  async findIntentByKey(k) { const id = intentsByKey.get(k); return id ? clone(intents.get(id)) : null; },
  async getIntent(id) { return clone(intents.get(id)); },
  async insertIntent(i) {
    if (intentsByKey.get(i.requestKey)) return null; // ON CONFLICT (request_key) DO NOTHING
    const row = { id: i.id, request_key: i.requestKey, status: 'prepared', module_id: i.moduleId, params: i.params, mint: i.mint, message_b64: i.messageB64, blockhash: i.blockhash, last_valid_block_height: i.lastValidBlockHeight, size_bytes: i.sizeBytes, account_count: i.accountCount, expires_at: i.expiresAt, signature: null, error: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
    intents.set(row.id, row); intentsByKey.set(i.requestKey, row.id); return clone(row);
  },
  async setIntentStatus(id, status, patch = {}) {
    const row = intents.get(id); if (!row) return null;
    row.status = status; if (patch.signature != null) row.signature = patch.signature; if (patch.error != null) row.error = patch.error; row.updated_at = new Date().toISOString();
    return clone(row);
  },
  async claimIntentForConfirm(id) {
    const row = intents.get(id); if (!row || row.status !== 'prepared') return null;
    row.status = 'confirming'; row.updated_at = new Date().toISOString(); return clone(row);
  },
  async setIntentSubmitted(id, patch) {
    const row = intents.get(id); if (!row) return null;
    row.signature = patch.signature; row.blockhash = patch.blockhash; row.last_valid_block_height = patch.lastValidBlockHeight; row.status = 'confirming'; row.updated_at = new Date().toISOString();
    return clone(row);
  },

  // ---- coins ----
  async getCoinByMint(mint) { const id = coinsByMint.get(mint); return id ? clone(coins.get(id)) : null; },
  async getCoin(id) { return clone(coins.get(id)); },
  async listLiveCoins() {
    return [...coins.values()].filter((c) => c.status === 'live').map((c) => ({ ...clone(c), kind: modules.get(c.module_id)?.kind ?? 'passthrough' }));
  },
  async insertCoin(c) {
    if (coinsByMint.get(c.mint)) return null; // ON CONFLICT (mint) DO NOTHING
    const row = { id: c.id, mint: c.mint, name: c.name, symbol: c.symbol, uri: c.uri, launch_wallet: c.launchWallet, sharing_config: c.sharingConfig, sharing_vault: c.sharingVault, bonding_curve: c.bondingCurve, module_id: c.moduleId, module_dest: c.moduleDest, buyback_dest: c.buybackDest, launch_signature: c.launchSignature, launch_slot: c.launchSlot, intent_id: c.intentId, status: 'live', split_verified: c.splitVerified, created_at: new Date().toISOString() };
    coins.set(row.id, row); coinsByMint.set(row.mint, row.id); return clone(row);
  },

  // ---- epochs ----
  async openEpoch(index, startedAt) {
    if (epochs.has(index)) return null;
    const row = { epoch_index: index, started_at: startedAt, ended_at: null, status: 'open', coins_processed: 0, lamports_distributed: 0 };
    epochs.set(index, row); return clone(row);
  },
  async getEpoch(index) { return clone(epochs.get(index)); },
  async setEpochStatus(index, status, patch = {}) {
    const row = epochs.get(index); if (!row) return null;
    row.status = status; if (patch.endedAt != null) row.ended_at = patch.endedAt; if (patch.coinsProcessed != null) row.coins_processed = patch.coinsProcessed; if (patch.lamportsDistributed != null) row.lamports_distributed = patch.lamportsDistributed;
    return clone(row);
  },
  async claimEpochDistribution(epochIndex, coinId) {
    const k = `${epochIndex}:${coinId}`; if (epochDist.has(k)) return null; // UNIQUE(epoch,coin)
    const row = { id: randomUUID(), epoch_index: epochIndex, coin_id: coinId, distributed_lamports: 0, module_lamports: 0, buyback_lamports: 0, signature: null, status: 'running', error: null };
    epochDist.set(k, row); return clone(row);
  },
  async finishEpochDistribution(id, patch) {
    const row = [...epochDist.values()].find((r) => r.id === id); if (!row) return null;
    row.distributed_lamports = patch.distributed ?? 0; row.module_lamports = patch.module ?? 0; row.buyback_lamports = patch.buyback ?? 0; row.signature = patch.signature ?? null; row.status = patch.status; row.error = patch.error ?? null;
    return clone(row);
  },

  // ---- receipts ----
  async insertReceipt(r) {
    const row = { id: r.id ?? randomUUID(), kind: r.kind, coin_id: r.coinId ?? null, epoch_index: r.epochIndex ?? null, signature: r.signature, slot: r.slot ?? null, lamports: r.lamports ?? null, fee_lamports: r.feeLamports ?? null, payload: r.payload ?? {}, solscan_url: r.solscanUrl, created_at: new Date().toISOString() };
    receipts.push(row); return clone(row);
  },
  async listReceiptsForCoin(coinId, limit = 50) {
    return receipts.filter((r) => r.coin_id === coinId).slice(-limit).reverse().map(clone);
  },

  // ---- ALT ----
  async upsertAlt(a) {
    const row = { table_address: a.tableAddress, creator: a.creator, entries: a.entries, entry_count: a.entryCount, active: true, created_at: alts.get(a.tableAddress)?.created_at ?? new Date().toISOString(), refreshed_at: new Date().toISOString() };
    alts.set(a.tableAddress, row); return clone(row);
  },

  async tx(fn) { return fn(null); }, // no real transactions in memory
};
