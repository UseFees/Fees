// Security unit test for the crank/buyback signer authorization gate
// (assertCrankAllowed). Chain-free: it exercises the exact policy the signer
// applies before signing. No validator, no keys, no mainnet.
//
//   node test/signer_security.mjs

// Minimal env so config (imported transitively) loads; nothing here touches chain.
process.env.DB_DRIVER = 'memory';
process.env.LAUNCH_ENABLED = 'false';
process.env.RPC_URL = 'http://127.0.0.1:8899';
process.env.EXPECTED_GENESIS = 'x';
const W = 'So11111111111111111111111111111111111111112';
process.env.LAUNCH_WALLET_PUBKEY = W;
process.env.CRANK_WALLET_PUBKEY = W;
process.env.BUYBACK_DEST = W;

const assert = (await import('node:assert/strict')).default;
const { PublicKey, Keypair, SystemProgram, AddressLookupTableProgram, TransactionInstruction } = await import('@solana/web3.js');
const { assertCrankAllowed } = await import('../src/signer/core.mjs');
const { PUMP, ixDistributeCreatorFeesV2, WSOL, TOKEN, pdas } = await import('../src/phase0.mjs');

let n = 0;
const ok = (name, fn) => { fn(); n++; console.log('ok  ', name); };
const wallet = Keypair.generate().publicKey;

// The real ALT create + extend that init_alt produces.
const [createIx, tableAddress] = AddressLookupTableProgram.createLookupTable({ authority: wallet, payer: wallet, recentSlot: 123 });
const extendIx = AddressLookupTableProgram.extendLookupTable({ authority: wallet, payer: wallet, lookupTable: tableAddress, addresses: [Keypair.generate().publicKey, Keypair.generate().publicKey] });

ok('ALT create is allowed', () => assert.doesNotThrow(() => assertCrankAllowed([createIx], wallet)));
ok('ALT extend is allowed', () => assert.doesNotThrow(() => assertCrankAllowed([extendIx], wallet)));
ok('ALT create + extend together (the init_alt tx) is allowed', () => assert.doesNotThrow(() => assertCrankAllowed([createIx, extendIx], wallet)));

// Destructive ALT instructions must still be rejected.
ok('ALT deactivate is REJECTED', () => {
  const ix = AddressLookupTableProgram.deactivateLookupTable({ lookupTable: tableAddress, authority: wallet });
  assert.throws(() => assertCrankAllowed([ix], wallet), /not allowed/);
});
ok('ALT close is REJECTED', () => {
  const ix = AddressLookupTableProgram.closeLookupTable({ lookupTable: tableAddress, authority: wallet, recipient: wallet });
  assert.throws(() => assertCrankAllowed([ix], wallet), /not allowed/);
});
ok('ALT freeze is REJECTED', () => {
  const ix = AddressLookupTableProgram.freezeLookupTable({ lookupTable: tableAddress, authority: wallet });
  assert.throws(() => assertCrankAllowed([ix], wallet), /not allowed/);
});

// An arbitrary unknown program is still rejected.
ok('unknown arbitrary program is REJECTED', () => {
  const evil = new TransactionInstruction({ programId: Keypair.generate().publicKey, keys: [], data: Buffer.from([1, 2, 3, 4]) });
  assert.throws(() => assertCrankAllowed([evil], wallet), /unknown program/);
});
ok('an ALT instruction mixed with an unknown program is REJECTED', () => {
  const evil = new TransactionInstruction({ programId: Keypair.generate().publicKey, keys: [], data: Buffer.alloc(4) });
  assert.throws(() => assertCrankAllowed([createIx, evil], wallet), /unknown program/);
});

// The legitimate crank workload (distribute) is allowed.
ok('distribute_creator_fees_v2 (the real crank workload) is allowed', () => {
  const mint = Keypair.generate().publicKey;
  const ix = ixDistributeCreatorFeesV2({ payer: wallet, mint, bondingCurveCreator: pdas.sharingConfig(mint), shareholders: [Keypair.generate().publicKey, Keypair.generate().publicKey] });
  assert.doesNotThrow(() => assertCrankAllowed([ix], wallet));
});

// SystemProgram transfer OUT of the signing wallet is rejected; createAccount is fine.
ok('SystemProgram transfer debiting the signing wallet is REJECTED', () => {
  const ix = SystemProgram.transfer({ fromPubkey: wallet, toPubkey: Keypair.generate().publicKey, lamports: 1 });
  assert.throws(() => assertCrankAllowed([ix], wallet), /transfer/);
});
ok('SystemProgram transfer NOT from the signing wallet is allowed', () => {
  const other = Keypair.generate().publicKey;
  const ix = SystemProgram.transfer({ fromPubkey: other, toPubkey: Keypair.generate().publicKey, lamports: 1 });
  assert.doesNotThrow(() => assertCrankAllowed([ix], wallet));
});

console.log(`\n${n} signer-security checks passed`);
