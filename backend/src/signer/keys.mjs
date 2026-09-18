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


export function loadKeypair({ path, json, base58 }, label) {
  if (base58) {
    let secret;
    try { secret = decodeBase58(base58.trim()); }
    catch { throw new Error(`${label}: keypair env is not valid base58`); }
    if (secret.length !== 64 && secret.length !== 32) {
      throw new Error(`${label}: base58 keypair is not a 32/64-byte secret`);
    }
    return Keypair.fromSecretKey(secret);
  }
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


const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function decodeBase58(s) {
  if (!s || typeof s !== 'string') throw new Error('base58 secret missing');
  let bytes = [0];
  for (const ch of s) {
    const val = BASE58.indexOf(ch);
    if (val < 0) throw new Error('invalid base58 character');
    let carry = val;
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (let i = 0; i < s.length - 1 && s[i] === '1'; i++) bytes.push(0);
  return Uint8Array.from(bytes.reverse());
}
