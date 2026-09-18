// Unit test for the non-throwing confirmation logic (confirmOrCheckSignature).
// Uses a mock Connection so the four required scenarios are deterministic and
// need no validator: normal, delayed, expired-but-landed, expired-not-landed
// (plus failed-on-chain and pre-expiry timeout for completeness).
//
//   node test/confirm.mjs

process.env.DB_DRIVER = 'memory';
process.env.RPC_URL = 'http://127.0.0.1:8899';
process.env.EXPECTED_GENESIS = 'x';
const W = 'So11111111111111111111111111111111111111112';
process.env.LAUNCH_WALLET_PUBKEY = W; process.env.CRANK_WALLET_PUBKEY = W; process.env.BUYBACK_DEST = W;

const assert = (await import('node:assert/strict')).default;
const { confirmOrCheckSignature } = await import('../src/solanaClient.mjs');

const CONFIRMED = { err: null, confirmationStatus: 'confirmed', confirmations: 1 };
const FINALIZED = { err: null, confirmationStatus: 'finalized', confirmations: null };
const FAILED = { err: { InstructionError: [0, { Custom: 6014 }] }, confirmationStatus: 'confirmed', confirmations: 1 };

// Mock Connection: statusQueue is consumed one per getSignatureStatuses call
// (last value repeats); height is a fixed number or a function of call count.
function mockConn({ statusQueue, height }) {
  let sIdx = 0, hIdx = 0;
  return {
    async getSignatureStatuses() { const v = statusQueue[Math.min(sIdx, statusQueue.length - 1)]; sIdx++; return { value: [v ?? null] }; },
    async getBlockHeight() { return typeof height === 'function' ? height(hIdx++) : height; },
  };
}

const OPTS = { signature: 'SIG', lastValidBlockHeight: 200, timeoutMs: 2000, pollMs: 5 };
let n = 0; const ok = async (name, fn) => { await fn(); n++; console.log('ok  ', name); };

// 1) normal: confirmed on the first poll
await ok('normal confirmation -> landed', async () => {
  const r = await confirmOrCheckSignature(mockConn({ statusQueue: [CONFIRMED], height: 100 }), OPTS);
  assert.deepEqual([r.landed, r.err, r.status], [true, null, 'confirmed']);
});

// 2) delayed: null a few times (height still valid), then confirmed
await ok('delayed confirmation -> landed', async () => {
  const r = await confirmOrCheckSignature(mockConn({ statusQueue: [null, null, null, CONFIRMED], height: 100 }), OPTS);
  assert.equal(r.landed, true); assert.equal(r.status, 'confirmed');
});

// 3) expired blockheight BUT tx already landed (found by the final history check)
await ok('expired blockheight but tx landed -> landed (finalized)', async () => {
  const r = await confirmOrCheckSignature(mockConn({ statusQueue: [null, FINALIZED], height: 300 }), OPTS);
  assert.equal(r.landed, true); assert.equal(r.status, 'confirmed'); assert.equal(r.err, null);
});

// 4) expired blockheight AND tx never landed
await ok('expired blockheight and tx NOT landed -> expired_not_landed (retry-safe, no throw)', async () => {
  const r = await confirmOrCheckSignature(mockConn({ statusQueue: [null, null], height: 300 }), OPTS);
  assert.equal(r.landed, false); assert.equal(r.status, 'expired_not_landed');
});

// bonus: executed but failed on chain
await ok('failed on chain -> landed with err', async () => {
  const r = await confirmOrCheckSignature(mockConn({ statusQueue: [FAILED], height: 100 }), OPTS);
  assert.equal(r.landed, true); assert.ok(r.err); assert.equal(r.status, 'failed');
});

// bonus: never lands before the client timeout, height still valid -> timeout (retryable, no throw)
await ok('pre-expiry timeout -> retryable timeout (no throw)', async () => {
  const r = await confirmOrCheckSignature(mockConn({ statusQueue: [null], height: 100 }), { ...OPTS, timeoutMs: 30, pollMs: 5 });
  assert.equal(r.landed, false); assert.equal(r.status, 'timeout');
});

console.log(`\n${n} confirmation checks passed`);
