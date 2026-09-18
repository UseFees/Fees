// /launch/prepare and /launch/confirm — the two-step flow Lovable calls.
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
import { assertCluster, connection, confirmSignature } from '../../solanaClient.mjs';
import { receiptOf, solscan } from '../../receipts/solscan.mjs';
import { decodeBondingCurve, decodeSharingConfig, pdas } from '../../phase0.mjs';
import { log } from '../../logger.mjs';

export const launchRouter = Router();

function badRequest(msg, code = 'bad_request') { const e = new Error(msg); e.status = 400; e.code = code; return e; }

function parseLaunchInput(body) {
  const { requestKey, name, symbol, uri, moduleId } = body ?? {};
  if (!requestKey || typeof requestKey !== 'string' || requestKey.length < 8) throw badRequest('requestKey (idempotency key, >=8 chars) is required');
  if (!name || !symbol) throw badRequest('name and symbol are required');
  if (String(name).length > 32 || String(symbol).length > 10) throw badRequest('name<=32 and symbol<=10 chars');
  if (!moduleId) throw badRequest('moduleId is required');
  let devBuyLamports = body.devBuyLamports != null ? Number(body.devBuyLamports) : config.defaultDevBuyLamports;
  if (!Number.isFinite(devBuyLamports) || devBuyLamports < 0) throw badRequest('devBuyLamports must be a non-negative integer (lamports)');
  if (devBuyLamports > config.maxDevBuyLamports) throw badRequest(`devBuyLamports exceeds the cap of ${config.maxDevBuyLamports}`, 'dev_buy_too_large');
  return { requestKey, name: String(name), symbol: String(symbol), uri: uri ? String(uri) : '', moduleId: String(moduleId), devBuyLamports: Math.floor(devBuyLamports) };
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
  const moduleDest = new PublicKey(module.module_dest);

  const launchId = randomUUID();
  const mint = await signer.newLaunchMint(launchId); // signer owns the secret
  const built = await buildLaunch({ name: input.name, symbol: input.symbol, uri: input.uri, devBuyLamports: input.devBuyLamports, moduleDest, mintPubkey: new PublicKey(mint) });

  const expiresAt = new Date(Date.now() + config.launchIntentTtlSeconds * 1000).toISOString();
  const intent = await repo.insertIntent({
    id: launchId, requestKey: input.requestKey, moduleId: input.moduleId,
    params: { ...input, moduleDest: module.module_dest, buybackDest: config.buybackDest.toBase58() },
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
      module: { id: module.id, moduleDest: module.module_dest, buybackDest: config.buybackDest.toBase58(), split: { moduleBps: 9000, feesBps: 1000 } },
      limits: built.limits,
      launchOrder: built.instructionNames,
      preview: { name: input.name, symbol: input.symbol, devBuyLamports: String(input.devBuyLamports), sharingConfig: built.sharingConfig.toBase58(), sharingVault: built.sharingVault.toBase58() },
    }),
  });
}));

launchRouter.post('/confirm', h(async (req, res) => {
  assertWritable();
  await assertCluster();
  const { launchId } = req.body ?? {};
  if (!launchId) throw badRequest('launchId is required');

  const intent = await repo.getIntent(launchId);
  if (!intent) throw badRequest('unknown launchId', 'unknown_launch');
  if (intent.status === 'confirmed') {
    const coin = await repo.getCoinByMint(intent.mint);
    return res.json({ idempotent: true, status: 'confirmed', launchId, signature: intent.signature, coin: coin ? publicCoin(coin) : null, solscan: solscan.tx(intent.signature) });
  }
  if (new Date(intent.expires_at).getTime() < Date.now()) {
    await repo.setIntentStatus(launchId, 'expired');
    throw badRequest('launch intent expired; call /launch/prepare again', 'expired');
  }

  // Only one confirm may proceed.
  const claimed = await repo.claimIntentForConfirm(launchId);
  if (!claimed) {
    const cur = await repo.getIntent(launchId);
    if (cur.status === 'confirmed') { const coin = await repo.getCoinByMint(cur.mint); return res.json({ idempotent: true, status: 'confirmed', launchId, signature: cur.signature, coin: coin ? publicCoin(coin) : null }); }
    throw badRequest(`launch is ${cur.status}; not confirmable`, 'not_confirmable');
  }

  let signature;
  try {
    ({ signature } = await signer.signAndSubmitLaunch({ launchId, messageBase64: intent.message_b64 }));
  } catch (e) {
    await repo.setIntentStatus(launchId, 'failed', { error: e.message });
    e.status = e.status ?? 502; throw e;
  }

  const confirmed = await confirmSignature(signature, intent.blockhash, Number(intent.last_valid_block_height));
  if (!confirmed || confirmed.meta?.err) {
    await repo.setIntentStatus(launchId, 'failed', { signature, error: JSON.stringify(confirmed?.meta?.err ?? 'not confirmed') });
    const e = new Error('launch transaction failed on chain'); e.status = 502; e.code = 'launch_failed'; e.signature = signature; throw e;
  }

  // Verify the split actually installed: bonding_curve.creator == sharing_config
  // and the config is 9000/1000 with admin_revoked.
  const mint = new PublicKey(intent.mint);
  const sharingConfig = pdas.sharingConfig(mint);
  const [bcInfo, scInfo] = await Promise.all([connection().getAccountInfo(pdas.bondingCurve(mint)), connection().getAccountInfo(sharingConfig)]);
  const curve = decodeBondingCurve(bcInfo?.data);
  const sc = scInfo ? decodeSharingConfig(scInfo.data) : null;
  const splitVerified = Boolean(curve && curve.creator.equals(sharingConfig)) && Boolean(sc && sc.adminRevoked && sc.totalBps === 10000);

  const module = await repo.getModule(intent.module_id);
  const coin = await repo.insertCoin({
    id: randomUUID(), mint: intent.mint, name: intent.params.name, symbol: intent.params.symbol, uri: intent.params.uri,
    launchWallet: config.launchWallet.toBase58(), sharingConfig: sharingConfig.toBase58(), sharingVault: pdas.creatorVault(sharingConfig).toBase58(),
    bondingCurve: pdas.bondingCurve(mint).toBase58(), moduleId: intent.module_id, moduleDest: module.module_dest, buybackDest: config.buybackDest.toBase58(),
    launchSignature: signature, launchSlot: confirmed.slot ?? null, intentId: launchId, splitVerified,
  });
  await repo.setIntentStatus(launchId, 'confirmed', { signature });
  await repo.insertReceipt(receiptOf({ kind: 'launch', coinId: coin?.id ?? null, signature, slot: confirmed.slot ?? null, feeLamports: confirmed.meta?.fee ?? null, payload: { mint: intent.mint, splitVerified } }));

  log.info('launch confirmed', { launchId, mint: intent.mint, signature, splitVerified });
  res.json({ status: 'confirmed', launchId, signature, splitVerified, coin: coin ? publicCoin(coin) : await repo.getCoinByMint(intent.mint).then(publicCoin), solscan: { tx: solscan.tx(signature), token: solscan.token(intent.mint) } });
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
