// /launch/prepare and /launch/confirm — the two-step flow frontend calls.
//
// prepare: idempotent by requestKey. Builds the E3-proven launch tx (creator
//   ALT, split-before-buy, 9000/1000), asks the signer for an ephemeral mint,
//   persists an intent, returns a preview. No signing, no chain write.
// confirm: atomically claims the intent, has the signer re-validate + sign +
//   submit, confirms on chain, verifies the split installed, writes the coin
//   and a launch receipt. Idempotent: a confirmed intent returns its coin.

import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import { h } from '../middleware.mjs';
import { config, assertWritable } from '../../config.mjs';
import { repo } from '../../db/repo.mjs';
import { signer } from '../../signer/index.mjs';
import { buildLaunch } from '../../launch/builder.mjs';
import { assertCluster, connection, confirmOrCheckSignature, getTx } from '../../solanaClient.mjs';
import { receiptOf, solscan } from '../../receipts/solscan.mjs';
import { decodeBondingCurve, decodeSharingConfig, pdas } from '../../phase0.mjs';
import { log } from '../../logger.mjs';

export const launchRouter = Router();

function badRequest(msg, code = 'bad_request') { const e = new Error(msg); e.status = 400; e.code = code; return e; }

function parseLaunchInput(body) {
  const { requestKey, name, symbol, uri, moduleId, moduleDest } = body ?? {};
  if (!requestKey || typeof requestKey !== 'string' || requestKey.length < 8) throw badRequest('requestKey (idempotency key, >=8 chars) is required');
  if (!name || !symbol) throw badRequest('name and symbol are required');
  if (String(name).length > 32 || String(symbol).length > 10) throw badRequest('name<=32 and symbol<=10 chars');
  if (!moduleId) throw badRequest('moduleId is required');
  let devBuyLamports = body.devBuyLamports != null ? Number(body.devBuyLamports) : config.defaultDevBuyLamports;
  if (!Number.isFinite(devBuyLamports) || devBuyLamports < 0) throw badRequest('devBuyLamports must be a non-negative integer (lamports)');
  if (devBuyLamports > config.maxDevBuyLamports) throw badRequest(`devBuyLamports exceeds the cap of ${config.maxDevBuyLamports}`, 'dev_buy_too_large');
  return { requestKey, name: String(name), symbol: String(symbol), uri: uri ? String(uri) : '', moduleId: String(moduleId), moduleDest: moduleDest ? String(moduleDest) : '', devBuyLamports: Math.floor(devBuyLamports) };
}

function intentToPreview(intent, extra = {}) {
  return {
    launchId: intent.id, status: intent.status, mint: intent.mint,
    sizeBytes: intent.size_bytes, sizeLimit: 1232, accountCount: intent.account_count,
    expiresAt: intent.expires_at, signature: intent.signature ?? null, ...extra,
  };
}

launchRouter.post('/prepare', h(async (req, res) => {
  assertWritable();
  await assertCluster();
  const input = parseLaunchInput(req.body);

  // Idempotency: a repeated requestKey returns the existing intent/coin.
  const existing = await repo.findIntentByKey(input.requestKey);
  if (existing) {
    const coin = existing.status === 'confirmed' ? await repo.getCoinByMint(existing.mint) : null;
    return res.json({ idempotent: true, ...intentToPreview(existing, coin ? { coin: publicCoin(coin) } : {}) });
  }

  const module = await repo.getModule(input.moduleId);
  if (!module) throw badRequest(`unknown or disabled module '${input.moduleId}'`, 'unknown_module');

  const requiresDestination = Boolean(module.config?.requiresDestination);
  let moduleDest;
  if (requiresDestination) {
    if (!input.moduleDest) throw badRequest('payout address is required for this fee option', 'module_dest_required');
    try { moduleDest = new PublicKey(input.moduleDest); }
    catch { throw badRequest('payout address is not a valid Solana address', 'invalid_module_dest'); }
    if (moduleDest.equals(config.buybackDest)) throw badRequest('payout address must differ from the FEES buyback destination', 'module_dest_conflict');
  } else {
    moduleDest = new PublicKey(module.module_dest);
  }

  const launchId = randomUUID();
  const mint = await signer.newLaunchMint(launchId); // signer owns the secret
  const built = await buildLaunch({ name: input.name, symbol: input.symbol, uri: input.uri, devBuyLamports: input.devBuyLamports, moduleDest, mintPubkey: new PublicKey(mint) });

  const expiresAt = new Date(Date.now() + config.launchIntentTtlSeconds * 1000).toISOString();
  const intent = await repo.insertIntent({
    id: launchId, requestKey: input.requestKey, moduleId: input.moduleId,
    params: { ...input, moduleDest: moduleDest.toBase58(), buybackDest: config.buybackDest.toBase58() },
    mint, messageB64: built.messageBase64, blockhash: built.blockhash, lastValidBlockHeight: built.lastValidBlockHeight,
    sizeBytes: built.limits.sizeBytes, accountCount: built.limits.accountCount, expiresAt,
  });
  // Race: another prepare with the same key won between find and insert.
  if (!intent) {
    const again = await repo.findIntentByKey(input.requestKey);
    return res.json({ idempotent: true, ...intentToPreview(again) });
  }

  log.info('launch prepared', { launchId, mint, module: input.moduleId, sizeBytes: built.limits.sizeBytes, accountCount: built.limits.accountCount });
  res.json({
    ...intentToPreview(intent, {
      module: { id: module.id, moduleDest: moduleDest.toBase58(), buybackDest: config.buybackDest.toBase58(), requiresDestination, split: { moduleBps: 9000, feesBps: 1000 } },
      limits: built.limits,
      launchOrder: built.instructionNames,
      preview: { name: input.name, symbol: input.symbol, devBuyLamports: String(input.devBuyLamports), sharingConfig: built.sharingConfig.toBase58(), sharingVault: built.sharingVault.toBase58() },
    }),
  });
}));

const MAX_LAUNCH_ATTEMPTS = Number(process.env.LAUNCH_MAX_SUBMIT_ATTEMPTS ?? 3);
const CONFIRM_TIMEOUT_MS = Number(process.env.LAUNCH_CONFIRM_TIMEOUT_MS ?? 45_000);

// The idempotency source of truth is ON-CHAIN state, not a specific signature.
// If the mint's bonding_curve.creator == sharing_config and the split is
// installed, the launch happened — whichever attempt landed it.
async function readLaunchState(mint) {
  const sharingConfig = pdas.sharingConfig(mint);
  const [bcInfo, scInfo] = await Promise.all([connection().getAccountInfo(pdas.bondingCurve(mint)), connection().getAccountInfo(sharingConfig)]);
  const curve = decodeBondingCurve(bcInfo?.data);
  const sc = scInfo ? decodeSharingConfig(scInfo.data) : null;
  const installed = Boolean(curve && curve.creator.equals(sharingConfig)) && Boolean(sc && sc.adminRevoked && sc.totalBps === 10000);
  return { sharingConfig, installed, splitVerified: installed };
}

// Persist the coin + receipt exactly once and return the success payload.
// insertCoin is ON CONFLICT (mint) DO NOTHING, so concurrent confirms converge
// to a single coin and a single launch.
async function finalizeLaunch(intent, mint, signature, splitVerified) {
  const sharingConfig = pdas.sharingConfig(mint);
  const module = await repo.getModule(intent.module_id);
  const alreadyConfirmed = intent.status === 'confirmed';
  const coin = await repo.insertCoin({
    id: randomUUID(), mint: intent.mint, name: intent.params.name, symbol: intent.params.symbol, uri: intent.params.uri,
    launchWallet: config.launchWallet.toBase58(), sharingConfig: sharingConfig.toBase58(), sharingVault: pdas.creatorVault(sharingConfig).toBase58(),
    bondingCurve: pdas.bondingCurve(mint).toBase58(), moduleId: intent.module_id, moduleDest: intent.params.moduleDest, buybackDest: config.buybackDest.toBase58(),
    launchSignature: signature, launchSlot: null, intentId: intent.id, splitVerified,
  });
  if (coin) { // first finalize only
    const tx = signature ? await getTx(signature).catch(() => null) : null;
    await repo.insertReceipt(receiptOf({ kind: 'launch', coinId: coin.id, signature: signature ?? 'unknown', slot: tx?.slot ?? null, feeLamports: tx?.meta?.fee ?? null, payload: { mint: intent.mint, splitVerified } }));
  }
  await repo.setIntentStatus(intent.id, 'confirmed', { signature });
  await signer.releaseLaunchMint(intent.id);
  const finalCoin = coin ?? await repo.getCoinByMint(intent.mint);
  log.info('launch confirmed', { launchId: intent.id, mint: intent.mint, signature, splitVerified, reused: !coin });
  return { status: 'confirmed', launchId: intent.id, signature, splitVerified, coin: publicCoin(finalCoin), solscan: { tx: signature ? solscan.tx(signature) : null, token: solscan.token(intent.mint) } };
}

launchRouter.post('/confirm', h(async (req, res) => {
  assertWritable();
  await assertCluster();
  const { launchId } = req.body ?? {};
  if (!launchId) throw badRequest('launchId is required');

  let intent = await repo.getIntent(launchId);
  if (!intent) throw badRequest('unknown launchId', 'unknown_launch');
  const mint = new PublicKey(intent.mint);

  // Already confirmed → idempotent success.
  if (intent.status === 'confirmed') {
    const coin = await repo.getCoinByMint(intent.mint);
    return res.json({ idempotent: true, status: 'confirmed', launchId, signature: intent.signature, coin: publicCoin(coin), solscan: { tx: intent.signature ? solscan.tx(intent.signature) : null, token: solscan.token(intent.mint) } });
  }

  // Before doing anything, if the launch already landed on chain (e.g. a prior
  // attempt succeeded but its confirm response was lost), finalize idempotently.
  {
    const st = await readLaunchState(mint);
    if (st.installed) { intent = await repo.getIntent(launchId); return res.json({ idempotent: true, ...(await finalizeLaunch(intent, mint, intent.signature, st.splitVerified)) }); }
  }

  // Claim prepared → confirming so only one caller submits the first time.
  if (intent.status === 'prepared') {
    const claimed = await repo.claimIntentForConfirm(launchId);
    if (!claimed) intent = await repo.getIntent(launchId); // lost the race; fall through to resume
    else intent = claimed;
  }
  if (intent.status === 'failed') throw badRequest('launch failed; call /launch/prepare again with a new requestKey', 'launch_failed');
  if (intent.status !== 'confirming') throw badRequest(`launch is ${intent.status}; not confirmable`, 'not_confirmable');

  // Submit (or resubmit with a fresh blockhash, SAME mint) and confirm, up to
  // MAX_LAUNCH_ATTEMPTS. Never re-signs without first checking on-chain state,
  // so a landed launch is never resubmitted and a second mint is never made.
  let lastSignature = intent.signature ?? null;
  let bh = intent.blockhash, lvbh = intent.last_valid_block_height != null ? Number(intent.last_valid_block_height) : null;

  for (let attempt = 0; attempt < MAX_LAUNCH_ATTEMPTS; attempt++) {
    // If we don't yet have a submitted signature for this attempt, submit one.
    if (!lastSignature || attempt > 0) {
      // Re-check chain first so we never resubmit over a landed launch.
      const pre = await readLaunchState(mint);
      if (pre.installed) return res.json(await finalizeLaunch(intent, mint, lastSignature, pre.splitVerified));
      let submit;
      try {
        submit = await signer.signAndSubmitLaunch({ launchId, messageBase64: intent.message_b64 });
      } catch (e) {
        // Mint gone (signer restarted / TTL) after prior submit → decide by chain.
        const post = await readLaunchState(mint);
        if (post.installed) return res.json(await finalizeLaunch(intent, mint, lastSignature, post.splitVerified));
        if (e.code === 'mint_missing') { await repo.setIntentStatus(launchId, 'failed', { error: e.message }); throw badRequest('launch could not be completed and the ephemeral mint expired; call /launch/prepare again', 'expired_resubmit'); }
        await repo.setIntentStatus(launchId, 'failed', { error: e.message }); e.status = e.status ?? 502; throw e;
      }
      lastSignature = submit.signature; bh = submit.blockhash; lvbh = Number(submit.lastValidBlockHeight);
      await repo.setIntentSubmitted(launchId, { signature: lastSignature, blockhash: bh, lastValidBlockHeight: lvbh });
    }

    const result = await confirmOrCheckSignature(connection(), { signature: lastSignature, lastValidBlockHeight: lvbh, timeoutMs: CONFIRM_TIMEOUT_MS });

    if (result.landed && !result.err) {
      const st = await readLaunchState(mint);
      return res.json(await finalizeLaunch(intent, mint, lastSignature, st.splitVerified));
    }
    if (result.landed && result.err) {
      // Executed and failed. But a DIFFERENT (racing) attempt may have created
      // the coin — trust chain state over this signature.
      const st = await readLaunchState(mint);
      if (st.installed) return res.json(await finalizeLaunch(intent, mint, lastSignature, st.splitVerified));
      await repo.setIntentStatus(launchId, 'failed', { signature: lastSignature, error: JSON.stringify(result.err) });
      const e = new Error('launch transaction failed on chain'); e.status = 422; e.code = 'launch_failed_onchain'; throw e;
    }
    // Not landed (expired or timeout). Loop will re-check chain, then resubmit
    // with a fresh blockhash on the next attempt.
    log.warn('launch not yet landed; will re-check/resubmit', { launchId, attempt, status: result.status, signature: lastSignature });
  }

  // Exhausted attempts without landing. Final chain check, else retry-safe 202.
  const finalState = await readLaunchState(mint);
  if (finalState.installed) return res.json(await finalizeLaunch(intent, mint, lastSignature, finalState.splitVerified));
  // Leave status 'confirming' so /launch/confirm can be safely retried later.
  return res.status(202).json({ status: 'pending', retryable: true, launchId, signature: lastSignature, message: 'launch submitted but not yet confirmed; retry /launch/confirm with the same launchId' });
}));

export function publicCoin(c) {
  if (!c) return null;
  return {
    id: c.id, mint: c.mint, name: c.name, symbol: c.symbol, uri: c.uri,
    sharingConfig: c.sharing_config, sharingVault: c.sharing_vault, bondingCurve: c.bonding_curve,
    moduleId: c.module_id, moduleDest: c.module_dest, buybackDest: c.buyback_dest,
    split: { moduleBps: 9000, feesBps: 1000 }, splitVerified: c.split_verified,
    launchSignature: c.launch_signature, status: c.status, createdAt: c.created_at,
    solscan: { token: solscan.token(c.mint), tx: solscan.tx(c.launch_signature) },
  };
}
