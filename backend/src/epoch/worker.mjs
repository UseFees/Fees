// Hourly epoch worker.
//
// For each live coin: read how much has accrued in its sharing vault, and if it
// clears the dust floor, crank distribute_creator_fees_v2 (permissionless — the
// crank wallet only pays the fee) to pay the on-chain 90/10 split to the coin's
// module_dest and buyback_dest. Then record a receipt + epoch_distribution and
// fire the module executor and the buyback hook.
//
// Idempotent: epoch_distributions has UNIQUE(epoch_index, coin_id), so a re-run
// (or a second worker) cannot double-distribute a coin in an epoch.

import { randomUUID } from 'node:crypto';
import { config } from '../config.mjs';
import { log } from '../logger.mjs';
import { connection, assertCluster, confirmOrCheckSignature, getTx } from '../solanaClient.mjs';
import { repo } from '../db/repo.mjs';
import { signer } from '../signer/index.mjs';
import { receiptOf } from '../receipts/solscan.mjs';
import { getExecutor } from '../modules/executor.mjs';
import '../modules/buybackModule.mjs'; // register 'buyback'
import { buildV0, ixDistributeCreatorFeesV2, decodeSharingConfig, pdas } from '../phase0.mjs';
import { PublicKey } from '@solana/web3.js';

function currentEpochIndex(now = Date.now()) {
  return Math.floor(now / config.epoch.intervalMs);
}

async function sharingShareholders(mint) {
  const info = await connection().getAccountInfo(pdas.sharingConfig(mint));
  if (!info) return null;
  const sc = decodeSharingConfig(info.data);
  return sc?.shareholders ?? null;
}

async function distributeForCoin(epochIndex, coin) {
  const claim = await repo.claimEpochDistribution(epochIndex, coin.id);
  if (!claim) return { status: 'already_claimed' }; // another worker took it

  const mint = new PublicKey(coin.mint);
  const vault = new PublicKey(coin.sharing_vault);
  const vaultBefore = (await connection().getAccountInfo(vault))?.lamports ?? 0;

  // The rent-exempt reserve stays in the vault; only the surplus is distributable.
  const rentReserve = await connection().getMinimumBalanceForRentExemption(0);
  const distributable = Math.max(0, vaultBefore - rentReserve);
  if (distributable < config.epoch.minDistributableLamports) {
    await repo.finishEpochDistribution(claim.id, { status: 'skipped_dust', distributed: 0 });
    return { status: 'skipped_dust', vaultBefore, distributable };
  }

  const shareholders = await sharingShareholders(mint);
  if (!shareholders || shareholders.length !== 2) {
    await repo.finishEpochDistribution(claim.id, { status: 'failed', error: 'sharing_config shareholders not 2' });
    return { status: 'failed', error: 'shareholders' };
  }
  // Order must match sharing_config exactly (E2). Use the on-chain order.
  const shareholderPubkeys = shareholders.map((s) => s.address);

  const ix = ixDistributeCreatorFeesV2({
    payer: new PublicKey(config.crankWallet),
    mint,
    bondingCurveCreator: pdas.sharingConfig(mint), // creator migrated to the sharing_config PDA
    shareholders: shareholderPubkeys,
    initializeAta: false,
  });
  const { blockhash, lastValidBlockHeight } = await connection().getLatestBlockhash(config.rpcCommitment);
  const tx = buildV0(new PublicKey(config.crankWallet), [ix], blockhash);
  const { signature } = await signer.signAndSubmitCrank({ messageBase64: Buffer.from(tx.message.serialize()).toString('base64') });
  // Non-throwing confirm: an expired/failed crank is recorded, not crashed. The
  // epoch_distributions UNIQUE(epoch,coin) row is already claimed, so a failed
  // distribution simply waits for the next epoch (idempotent, no double-pay).
  const outcome = await confirmOrCheckSignature(connection(), { signature, lastValidBlockHeight });
  if (!outcome.landed || outcome.err) {
    await repo.finishEpochDistribution(claim.id, { status: 'failed', signature, error: outcome.err ? JSON.stringify(outcome.err) : outcome.status });
    return { status: 'failed', signature, reason: outcome.status };
  }
  const confirmed = await getTx(signature);

  // Exact deltas from the confirmed transaction.
  const keys = confirmed?.transaction.message.staticAccountKeys ?? [];
  const idxOf = (pk) => keys.findIndex((k) => k.toBase58() === pk);
  const deltaOf = (pk) => { const i = idxOf(pk); return i < 0 ? 0 : (confirmed.meta.postBalances[i] - confirmed.meta.preBalances[i]); };
  const moduleLamports = BigInt(Math.max(0, deltaOf(coin.module_dest)));
  const buybackLamports = BigInt(Math.max(0, deltaOf(coin.buyback_dest)));
  const distributed = moduleLamports + buybackLamports;

  await repo.finishEpochDistribution(claim.id, {
    status: 'distributed', distributed: distributed.toString(), module: moduleLamports.toString(), buyback: buybackLamports.toString(), signature,
  });
  await repo.insertReceipt(receiptOf({
    kind: 'distribute', coinId: coin.id, epochIndex, signature, slot: confirmed?.slot ?? null,
    lamports: distributed.toString(), feeLamports: confirmed?.meta?.fee ?? null,
    payload: { module_lamports: moduleLamports.toString(), buyback_lamports: buybackLamports.toString(), module_dest: coin.module_dest, buyback_dest: coin.buyback_dest },
  }));

  // Fire the module executor (90% side, coin.kind from the joined module) and
  // the buyback hook (10% side) — both non-fatal and idempotent.
  const ctx = { coin, epochIndex, moduleLamports, buybackLamports, signature };
  for (const kind of [coin.kind ?? 'passthrough', 'buyback']) {
    try { await getExecutor(kind).onDistribution(ctx); }
    catch (e) { log.error('module executor failed (non-fatal)', { coin: coin.mint, kind, err: e.message }); }
  }

  return { status: 'distributed', signature, distributed: distributed.toString(), moduleLamports: moduleLamports.toString(), buybackLamports: buybackLamports.toString() };
}

export async function runEpochOnce(now = Date.now()) {
  await assertCluster();
  const epochIndex = currentEpochIndex(now);
  await repo.openEpoch(epochIndex, new Date(epochIndex * config.epoch.intervalMs).toISOString());
  await repo.setEpochStatus(epochIndex, 'running');

  const coins = await repo.listLiveCoins();
  let processed = 0; let totalDistributed = 0n;
  for (const coin of coins) {
    try {
      const r = await distributeForCoin(epochIndex, coin);
      if (r.status === 'distributed') { processed++; totalDistributed += BigInt(r.distributed); }
      log.info('epoch coin processed', { epochIndex, mint: coin.mint, ...r });
    } catch (e) {
      log.error('epoch coin failed', { epochIndex, mint: coin.mint, err: e.message });
    }
  }
  await repo.setEpochStatus(epochIndex, 'closed', { endedAt: new Date().toISOString(), coinsProcessed: processed, lamportsDistributed: totalDistributed.toString() });
  log.info('epoch closed', { epochIndex, coins: coins.length, processed, totalDistributed: totalDistributed.toString() });
  return { epochIndex, processed, totalDistributed: totalDistributed.toString() };
}

// Long-running mode: align to the epoch boundary and run each interval.
async function main() {
  if (!config.launchEnabled) log.warn('LAUNCH_ENABLED is false: worker will read coins and compute, but the crank signer will refuse to submit writes');
  log.info('epoch worker started', { intervalMs: config.epoch.intervalMs });
  // Run once immediately, then on each interval boundary.
  await runEpochOnce().catch((e) => log.error('epoch run failed', { err: e.message }));
  setInterval(() => { runEpochOnce().catch((e) => log.error('epoch run failed', { err: e.message })); }, config.epoch.intervalMs);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
