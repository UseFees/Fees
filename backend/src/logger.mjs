// Structured JSON logging with a hard redaction pass. No secret ever reaches a
// log line: any field whose key looks like a key/secret, and any base58 string
// long enough to be a 64-byte secret key, is masked.

const SECRET_KEY = /(secret|private|keypair|mnemonic|seed|token|password|authorization)/i;
const LONG_B58 = /[1-9A-HJ-NP-Za-km-z]{80,}/g; // 64-byte secret keys encode to ~87-88 chars

function scrub(value, key) {
  if (key && SECRET_KEY.test(key)) return '[redacted]';
  if (typeof value === 'string') return value.replace(LONG_B58, '[redacted-key]');
  if (Array.isArray(value)) return value.map((v) => scrub(v));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = scrub(v, k);
    return out;
  }
  return value;
}

function emit(level, msg, fields) {
  const line = { t: new Date().toISOString(), level, msg, ...scrub(fields ?? {}) };
  const s = JSON.stringify(line);
  if (level === 'error') console.error(s);
  else console.log(s);
}

export const log = {
  info: (msg, fields) => emit('info', msg, fields),
  warn: (msg, fields) => emit('warn', msg, fields),
  error: (msg, fields) => emit('error', msg, fields),
  child: (base) => ({
    info: (msg, fields) => emit('info', msg, { ...base, ...fields }),
    warn: (msg, fields) => emit('warn', msg, { ...base, ...fields }),
    error: (msg, fields) => emit('error', msg, { ...base, ...fields }),
  }),
};
