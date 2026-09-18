// Read endpoints for the frontend: list coins, one coin, its receipts, modules.

import { Router } from 'express';
import { h } from '../middleware.mjs';
import { repo } from '../../db/repo.mjs';
import { publicCoin } from './launch.mjs';
import { solscan } from '../../receipts/solscan.mjs';

export const coinsRouter = Router();

coinsRouter.get('/', h(async (_req, res) => {
  const coins = await repo.listLiveCoins();
  res.json({ coins: coins.map(publicCoin) });
}));

coinsRouter.get('/:mint', h(async (req, res) => {
  const coin = await repo.getCoinByMint(req.params.mint);
  if (!coin) return res.status(404).json({ error: 'coin not found' });
  res.json({ coin: publicCoin(coin) });
}));

coinsRouter.get('/:mint/receipts', h(async (req, res) => {
  const coin = await repo.getCoinByMint(req.params.mint);
  if (!coin) return res.status(404).json({ error: 'coin not found' });
  const receipts = await repo.listReceiptsForCoin(coin.id, Math.min(200, Number(req.query.limit) || 50));
  res.json({
    coin: coin.mint,
    receipts: receipts.map((r) => ({ kind: r.kind, signature: r.signature, slot: r.slot, lamports: r.lamports, feeLamports: r.fee_lamports, epochIndex: r.epoch_index, solscan: r.solscan_url, payload: r.payload, createdAt: r.created_at })),
  });
}));

export const modulesRouter = Router();
modulesRouter.get('/', h(async (_req, res) => {
  const modules = await repo.listModules();
  res.json({ modules: modules.map((m) => ({ id: m.id, name: m.name, kind: m.kind, moduleDest: m.module_dest, solscan: solscan.account(m.module_dest) })) });
}));
