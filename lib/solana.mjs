// Minimal, dependency-free Solana helpers.
//
// E0 and E1 are read-only and must not need the Solana SDKs, so that the only
// thing standing between this harness and a result is one RPC host. Base58,
// ed25519 on-curve testing and PDA derivation are implemented here directly.
//
// E2 onward build and sign transactions and will use @solana/web3.js properly.

import { createHash } from 'node:crypto';

/* ---------- base58 ---------- */

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const MAP = new Map([...ALPHABET].map((c, i) => [c, i]));

export function b58encode(bytes) {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  // Must start empty: a leading [0] would append a spurious '1' for an
  // all-zero key, which is exactly the kind of off-by-one that silently
  // corrupts an address.
  const digits = [];
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i];
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  return '1'.repeat(zeros) + digits.reverse().map((d) => ALPHABET[d]).join('');
}

export function b58decode(str) {
  let zeros = 0;
  while (zeros < str.length && str[zeros] === '1') zeros++;
  // Same reason as b58encode: starting at [0] appends a spurious zero byte.
  const bytes = [];
  for (let i = zeros; i < str.length; i++) {
    const value = MAP.get(str[i]);
    if (value === undefined) throw new Error(`invalid base58 character: ${str[i]}`);
    let carry = value;
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  return Buffer.from([...new Array(zeros).fill(0), ...bytes.reverse()]);
}

/* ---------- ed25519 on-curve test ---------- */
// A program-derived address must NOT lie on the ed25519 curve, which is what
// guarantees no private key exists for it. Decompression follows RFC 8032.

const P = (1n << 255n) - 19n;
const D = mod(-121665n * inv(121666n));

function mod(a, m = P) {
  const r = a % m;
  return r < 0n ? r + m : r;
}

function pow(base, exp, m = P) {
  let result = 1n;
  let b = mod(base, m);
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % m;
    b = (b * b) % m;
    e >>= 1n;
  }
  return result;
}

function inv(a) {
  return pow(a, P - 2n);
}

const SQRT_M1 = pow(2n, (P - 1n) / 4n);

export function isOnCurve(bytes) {
  if (bytes.length !== 32) return false;
  // y is the little-endian integer with the top bit stripped (it carries x's sign).
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(i === 31 ? bytes[i] & 0x7f : bytes[i]);
  if (y >= P) return false;

  const y2 = mod(y * y);
  const u = mod(y2 - 1n);
  const v = mod(D * y2 + 1n);

  // x = u * v^3 * (u * v^7)^((p-5)/8)
  const v3 = mod(v * v * v);
  const v7 = mod(v3 * v3 * v);
  let x = mod(u * v3 * pow(mod(u * v7), (P - 5n) / 8n));

  const vxx = mod(v * x * x);
  if (vxx === u) return true;
  if (vxx === mod(-u)) {
    x = mod(x * SQRT_M1);
    return mod(v * x * x) === u;
  }
  return false;
}

/* ---------- PDA derivation ---------- */

const PDA_MARKER = Buffer.from('ProgramDerivedAddress', 'utf8');

export function createProgramAddress(seeds, programId) {
  const parts = seeds.map((s) => (Buffer.isBuffer(s) ? s : Buffer.from(s)));
  for (const p of parts) if (p.length > 32) throw new Error('seed longer than 32 bytes');
  const hash = createHash('sha256')
    .update(Buffer.concat([...parts, b58decode(programId), PDA_MARKER]))
    .digest();
  if (isOnCurve(hash)) throw new Error('address is on the curve');
  return b58encode(hash);
}

export function findProgramAddress(seeds, programId) {
  for (let bump = 255; bump >= 0; bump--) {
    try {
      return { address: createProgramAddress([...seeds, Buffer.from([bump])], programId), bump };
    } catch {
      /* on-curve, try the next bump */
    }
  }
  throw new Error('no off-curve address found');
}

// Anchor stores its IDL at createWithSeed(base, "anchor:idl", programId), where
// base is the program's authority PDA derived from no seeds.
export function createWithSeed(base, seed, programId) {
  const hash = createHash('sha256')
    .update(Buffer.concat([b58decode(base), Buffer.from(seed, 'utf8'), b58decode(programId)]))
    .digest();
  return b58encode(hash);
}

export function anchorIdlAddress(programId) {
  const { address: base } = findProgramAddress([], programId);
  return { base, idlAddress: createWithSeed(base, 'anchor:idl', programId) };
}

/* ---------- JSON-RPC ---------- */

export function makeRpc(url, { label = 'rpc' } = {}) {
  if (!url) throw new Error(`no RPC endpoint configured for ${label}`);
  let id = 0;
  return async function call(method, params = []) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
    });
    if (!res.ok) throw new Error(`${label} ${method} -> HTTP ${res.status}`);
    const json = await res.json();
    if (json.error) throw new Error(`${label} ${method} -> ${JSON.stringify(json.error)}`);
    return json.result;
  };
}

export async function getAccount(call, address, encoding = 'base64') {
  const res = await call('getAccountInfo', [address, { encoding, commitment: 'finalized' }]);
  if (!res?.value) return null;
  const v = res.value;
  return {
    owner: v.owner,
    lamports: v.lamports,
    executable: v.executable,
    rentEpoch: v.rentEpoch,
    data: Buffer.from(v.data[0], 'base64'),
  };
}
