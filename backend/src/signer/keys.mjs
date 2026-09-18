// Keypair loading for the signer service ONLY. Never imported by the API.
// Keys are read from a file path given by an env var (the same discipline as
// Phase 0 lib/safety.mjs) and never logged, returned, or serialized.

import { readFileSync } from 'node:fs';
import { Keypair } from '@solana/web3.js';

export function loadKeypairFromFile(path, label) {
  if (!path) throw new Error(`${label}: no keypair path configured`);
  let secret;
  try {
    secret = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new Error(`${label}: cannot read keypair file (${e.code ?? e.message})`);
  }
  if (!Array.isArray(secret) || (secret.length !== 64 && secret.length !== 32)) {
    throw new Error(`${label}: keypair file is not a 32/64-byte secret array`);
  }
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}


export function loadKeypair({ path, json }, label) {
  if (json) {
    let secret;
    try { secret = JSON.parse(json); }
    catch { throw new Error(`${label}: keypair env is not valid JSON`); }
    if (!Array.isArray(secret) || (secret.length !== 64 && secret.length !== 32)) {
      throw new Error(`${label}: keypair env is not a 32/64-byte secret array`);
    }
    return Keypair.fromSecretKey(Uint8Array.from(secret));
  }
  return loadKeypairFromFile(path, label);
}
