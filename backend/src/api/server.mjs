// FEES API server. Thin: auth + idempotent launch flow + reads. Holds NO keys
// (all signing goes through the signer service). Writes are gated by
// LAUNCH_ENABLED.

import express from 'express';
import { config } from '../config.mjs';
import { log } from '../logger.mjs';
import { auth, cors, requestId, errorHandler, h } from './middleware.mjs';
import { launchRouter } from './routes/launch.mjs';
import { coinsRouter, modulesRouter } from './routes/coins.mjs';
import { assertCluster, connection } from '../solanaClient.mjs';

export function createApp() {
const app = express();
app.use(express.json({ limit: '256kb' }));
app.use(cors);
app.use(requestId);

// Health/readiness — unauthenticated, no writes.
app.get('/health', (_req, res) => res.json({ ok: true, env: config.env, cluster: config.cluster, launchEnabled: config.launchEnabled }));
app.get('/ready', h(async (_req, res) => {
  await assertCluster();
  const slot = await connection().getSlot(config.rpcCommitment);
  res.json({ ok: true, slot, launchWallet: config.launchWallet.toBase58(), altAddress: config.altAddress?.toBase58() ?? null, feesMint: config.feesMintAddress });
}));

// Everything below requires the API token (if set).
app.use(auth);
app.use('/launch', launchRouter);
app.use('/coins', coinsRouter);
app.use('/modules', modulesRouter);

app.use(errorHandler);
  return app;
}

export function start(port = config.port) {
  const app = createApp();
  return app.listen(port, () => {
    log.info('FEES API listening', { port, env: config.env, launchEnabled: config.launchEnabled, signerMode: config.signer.mode });
    if (!config.launchEnabled) log.warn('LAUNCH_ENABLED=false: /launch/* will return 503 until enabled');
  });
}

// Only auto-start when run directly (`npm run api`), not when imported by tests.
if (import.meta.url === `file://${process.argv[1]}`) start();
