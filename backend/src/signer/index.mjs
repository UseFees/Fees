// Signer client used by the API and worker. In 'http' mode it calls the
// separate signer service (production). In 'inprocess' mode it imports the core
// directly (alpha/dev convenience only — the API then holds the keys, which is
// why config warns against it in production).

import { config } from '../config.mjs';
import { log } from '../logger.mjs';

async function httpCall(path, body) {
  const res = await fetch(`${config.signer.url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${config.signer.token ?? ''}` },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(json.error || `signer ${path} -> ${res.status}`); e.code = json.code; e.status = res.status; throw e; }
  return json;
}

let _core = null;
async function core() {
  if (config.signer.mode !== 'inprocess') return null;
  if (!_core) { _core = await import('./core.mjs'); log.warn('signer running IN-PROCESS: API holds keys; use SIGNER_MODE=http in production'); }
  return _core;
}

export const signer = {
  async newLaunchMint(launchId) {
    const c = await core(); if (c) return c.newLaunchMint(launchId);
    return (await httpCall('/mint', { launchId })).mint;
  },
  async signAndSubmitLaunch(args) {
    const c = await core(); if (c) return c.signAndSubmitLaunch(args);
    return httpCall('/sign/launch', args);
  },
  async signAndSubmitCrank(args) {
    const c = await core(); if (c) return c.signAndSubmitCrank(args);
    return httpCall('/sign/crank', args);
  },
};
