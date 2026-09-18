// The signer as a SEPARATE process. Run it on its own host/container with the
// keypair files and no inbound access except from the API over a private
// network + shared token. This is the deployment that realises signer
// separation: the API process never has LAUNCH_KEYPAIR_PATH/CRANK_KEYPAIR_PATH.

import express from 'express';
import { config } from '../config.mjs';
import { log } from '../logger.mjs';
import { newLaunchMint, signAndSubmitLaunch, signAndSubmitCrank, launchWalletPubkey, crankWalletPubkey } from './core.mjs';

const app = express();
app.use(express.json({ limit: '256kb' }));

// Shared-secret auth. Constant-time compare.
function authed(req) {
  const t = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const want = config.signer.token || '';
  if (!want || t.length !== want.length) return false;
  let diff = 0; for (let i = 0; i < want.length; i++) diff |= t.charCodeAt(i) ^ want.charCodeAt(i);
  return diff === 0;
}
app.use((req, res, next) => { if (!authed(req)) return res.status(401).json({ error: 'unauthorized' }); next(); });

app.get('/health', (_req, res) => res.json({ ok: true, launchWallet: launchWalletPubkey(), crankWallet: crankWalletPubkey() }));

app.post('/mint', (req, res) => {
  const { launchId } = req.body ?? {};
  if (!launchId) return res.status(400).json({ error: 'launchId required' });
  res.json({ mint: newLaunchMint(launchId) });
});

app.post('/sign/launch', async (req, res) => {
  try { res.json(await signAndSubmitLaunch(req.body ?? {})); }
  catch (e) { log.error('sign/launch failed', { code: e.code, msg: e.message }); res.status(422).json({ error: e.message, code: e.code ?? 'error' }); }
});

app.post('/sign/crank', async (req, res) => {
  try { res.json(await signAndSubmitCrank(req.body ?? {})); }
  catch (e) { log.error('sign/crank failed', { code: e.code, msg: e.message }); res.status(422).json({ error: e.message, code: e.code ?? 'error' }); }
});

const port = config.signer.port;
app.listen(port, '127.0.0.1', () => log.info('signer service listening', { port, launchWallet: launchWalletPubkey() }));
