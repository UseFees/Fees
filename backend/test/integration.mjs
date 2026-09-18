// Thin end-to-end integration test for the FEES backend against the LOCAL
// cloned validator (the same one E2/E3 use). It boots the real API + the
// in-process signer + the in-memory DB, creates the launch ALT, and drives the
// exact frontend flow, asserting every property the brief lists.
//
// No Postgres, no mainnet. Refuses to run against a public cluster (the genesis
// guard) and uses only freshly generated local test wallets funded by airdrop.
//
//   RPC_LOCAL=http://127.0.0.1:8899 node test/integration.mjs
//
// Requires: tools/clone_validator.sh running (pump/pump_amm/pump_fees/mayhem +
// Global + fee-recipient ATAs cloned), and `npm install` in backend/.

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';

const RPC = process.env.RPC_LOCAL || 'http://127.0.0.1:8899';
const PUBLIC_GENESIS = new Set(['5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d', 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG', '4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY']);

const results = [];
const check = (name, fn) => { try { fn(); results.push({ name, ok: true }); console.log(`  ok    ${name}`); } catch (e) { results.push({ name, ok: false, err: e.message }); console.log(`  FAIL  ${name}\n        ${e.message}`); } };

async function airdrop(conn, pubkey, sol) {
  const sig = await conn.requestAirdrop(pubkey, sol * LAMPORTS_PER_SOL);
  const bh = await conn.getLatestBlockhash('confirmed');
  await conn.confirmTransaction({ signature: sig, ...bh }, 'confirmed');
}

async function main() {
  // ---- guard: local cluster only ----
  const probe = new Connection(RPC, 'confirmed');
  const genesis = await probe.getGenesisHash().catch(() => { throw new Error(`cannot reach local validator at ${RPC}; start tools/clone_validator.sh`); });
  if (PUBLIC_GENESIS.has(genesis)) throw new Error(`refusing to run: ${RPC} is a PUBLIC cluster (genesis ${genesis})`);

  // ---- generate local test wallets ----
  const launch = Keypair.generate(), crank = Keypair.generate(), trader = Keypair.generate();
  const buybackDest = Keypair.generate().publicKey, moduleDest = Keypair.generate().publicKey;
  const keydir = mkdtempSync(join(tmpdir(), 'fees-it-'));
  const launchPath = join(keydir, 'launch.json'), crankPath = join(keydir, 'crank.json');
  writeFileSync(launchPath, JSON.stringify(Array.from(launch.secretKey)));
  writeFileSync(crankPath, JSON.stringify(Array.from(crank.secretKey)));

  // ---- configure the backend for local, BEFORE importing any config-bound module ----
  Object.assign(process.env, {
    NODE_ENV: 'test', DB_DRIVER: 'memory', LAUNCH_ENABLED: 'true',
    RPC_URL: RPC, RPC_COMMITMENT: 'confirmed', EXPECTED_GENESIS: genesis, CLUSTER: 'devnet',
    LAUNCH_WALLET_PUBKEY: launch.publicKey.toBase58(), CRANK_WALLET_PUBKEY: crank.publicKey.toBase58(),
    BUYBACK_DEST: buybackDest.toBase58(),
    SIGNER_MODE: 'inprocess', LAUNCH_KEYPAIR_PATH: launchPath, CRANK_KEYPAIR_PATH: crankPath,
    API_TOKEN: 'test-token', DEFAULT_DEV_BUY_LAMPORTS: String(0.5 * LAMPORTS_PER_SOL), MAX_DEV_BUY_LAMPORTS: String(2 * LAMPORTS_PER_SOL),
    EPOCH_MIN_DISTRIBUTABLE_LAMPORTS: '1', EPOCH_INTERVAL_MS: '3600000',
  });

  // ---- dynamic imports (now that env is set) ----
  const { config } = await import('../src/config.mjs');
  const { connection } = await import('../src/solanaClient.mjs');
  const { repo } = await import('../src/db/repo.mjs');
  const { loadGlobal, buildCreateAltInstructions, waitAltReady } = await import('../src/launch/alt.mjs');
  const { signer } = await import('../src/signer/index.mjs');
  const { createApp } = await import('../src/api/server.mjs');
  const { runEpochOnce } = await import('../src/epoch/worker.mjs');
  const phase0 = await import('../src/phase0.mjs');

  const conn = connection();

  // ---- fund wallets ----
  await airdrop(conn, launch.publicKey, 50);
  await airdrop(conn, crank.publicKey, 5);
  await airdrop(conn, trader.publicKey, 30);
  await airdrop(conn, moduleDest, 0.1);
  await airdrop(conn, buybackDest, 0.1);

  // ---- create the launch ALT (crank authors it) and pin it ----
  const global = await loadGlobal();
  const { instructions: altIx, tableAddress, addresses } = await buildCreateAltInstructions(global);
  const { blockhash: altBh, lastValidBlockHeight: altLvbh } = await conn.getLatestBlockhash('confirmed');
  const altTx = phase0.buildV0(crank.publicKey, altIx, altBh);
  await signer.signAndSubmitCrank({ messageBase64: Buffer.from(altTx.message.serialize()).toString('base64') });
  await waitAltReady(tableAddress, addresses.length, {});
  config.altAddress = tableAddress; // pin for this process
  check('creator ALT created with 22 entries', () => assert.equal(addresses.length, 22));

  // ---- seed a module ----
  await repo.upsertModule({ id: 'hold-v1', name: 'Hold', kind: 'passthrough', moduleDest: moduleDest.toBase58(), config: {}, enabled: true });

  // ---- boot the API on an ephemeral port ----
  const server = createApp().listen(0);
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const api = (path, body, method = 'POST') => fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json', authorization: 'Bearer test-token' }, body: body ? JSON.stringify(body) : undefined }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => ({})) }));

  try {
    // === GET /modules ===
    const modules = await api('/modules', null, 'GET');
    check('GET /modules returns the seeded module', () => { assert.equal(modules.status, 200); assert.ok(modules.json.modules.find((m) => m.id === 'hold-v1' && m.moduleDest === moduleDest.toBase58())); });

    // === POST /launch/prepare ===
    const requestKey = `it-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const prep = await api('/launch/prepare', { requestKey, name: 'Integration Coin', symbol: 'ITC', uri: 'https://example.invalid/itc.json', moduleId: 'hold-v1' });
    check('POST /launch/prepare succeeds', () => assert.equal(prep.status, 200));
    const p = prep.json;
    check('prepare: tx <= 1232 bytes', () => assert.ok(p.sizeBytes <= 1232, `sizeBytes=${p.sizeBytes}`));
    check('prepare: ALT actually compressed the tx', () => { assert.equal(p.limits.compression.compressed, true); assert.ok(p.limits.compression.lookupAccounts > 0, 'no lookup accounts'); });
    check('prepare: split is 9000/1000', () => { assert.equal(p.module.split.moduleBps, 9000); assert.equal(p.module.split.feesBps, 1000); });
    check('prepare: split installed BEFORE buy (create_v2 < create_fsc < update_v2 < buy_v2)', () => {
      const order = p.launchOrder;
      const iC = order.indexOf('create_v2'), iF = order.indexOf('create_fsc'), iU = order.indexOf('update_v2'), iB = order.indexOf('buy_v2');
      assert.ok(iC >= 0 && iF >= 0 && iU >= 0 && iB >= 0, `missing steps: ${order}`);
      assert.ok(iC < iF && iF < iU && iU < iB, `bad order: ${order.join(',')}`);
    });
    check('prepare: frontend-shaped response', () => { for (const k of ['launchId', 'mint', 'sizeBytes', 'expiresAt']) assert.ok(p[k] != null, `missing ${k}`); assert.ok(p.preview.sharingConfig && p.preview.sharingVault); });

    const mint = new PublicKey(p.mint);
    const sharingConfig = phase0.pdas.sharingConfig(mint);
    const launchOwnVaultBefore = (await conn.getAccountInfo(phase0.pdas.creatorVault(launch.publicKey)))?.lamports ?? 0;

    // === idempotent prepare: same requestKey returns same intent ===
    const prep2 = await api('/launch/prepare', { requestKey, name: 'X', symbol: 'X', moduleId: 'hold-v1' });
    check('prepare idempotency: same requestKey -> same launchId + mint', () => { assert.equal(prep2.json.idempotent, true); assert.equal(prep2.json.launchId, p.launchId); assert.equal(prep2.json.mint, p.mint); });

    // === POST /launch/confirm ===
    const conf = await api('/launch/confirm', { launchId: p.launchId });
    check('POST /launch/confirm succeeds', () => assert.equal(conf.status, 200));
    const c = conf.json;
    check('confirm: status confirmed + signature', () => { assert.equal(c.status, 'confirmed'); assert.ok(c.signature); });
    check('confirm: splitVerified === true', () => assert.equal(c.splitVerified, true));
    check('confirm: coin response frontend-shaped (split 9000/1000, solscan links)', () => {
      assert.equal(c.coin.split.moduleBps, 9000); assert.equal(c.coin.split.feesBps, 1000);
      assert.ok(c.solscan.tx.startsWith('http')); assert.ok(c.solscan.token.startsWith('http'));
      assert.equal(c.coin.moduleDest, moduleDest.toBase58()); assert.equal(c.coin.buybackDest, buybackDest.toBase58());
    });

    // === on-chain verification ===
    const [bcInfo, scInfo] = await Promise.all([conn.getAccountInfo(phase0.pdas.bondingCurve(mint)), conn.getAccountInfo(sharingConfig)]);
    const curve = phase0.decodeBondingCurve(bcInfo.data);
    const sc = phase0.decodeSharingConfig(scInfo.data);
    check('on-chain: bonding_curve.creator == sharing_config', () => assert.equal(curve.creator.toBase58(), sharingConfig.toBase58()));
    check('on-chain: sharing_config is 9000/1000, total 10000', () => {
      const mod = sc.shareholders.find((s) => s.address.equals(moduleDest));
      const buy = sc.shareholders.find((s) => s.address.equals(buybackDest));
      assert.equal(sc.totalBps, 10000); assert.equal(mod.shareBps, 9000); assert.equal(buy.shareBps, 1000);
    });
    check('on-chain: admin_revoked === true (split is immutable)', () => assert.equal(sc.adminRevoked, true));

    const sharingVaultLamports = (await conn.getAccountInfo(phase0.pdas.creatorVault(sharingConfig)))?.lamports ?? 0;
    const launchOwnVaultAfter = (await conn.getAccountInfo(phase0.pdas.creatorVault(launch.publicKey)))?.lamports ?? 0;
    check('no fee-escape window: sharing vault funded, launch-wallet vault delta 0', () => {
      assert.ok(sharingVaultLamports > 0, 'sharing vault empty');
      assert.equal(launchOwnVaultAfter - launchOwnVaultBefore, 0, 'a creator fee escaped to the launch wallet vault');
    });

    // === idempotent confirm: retry returns same signature, no second coin ===
    const conf2 = await api('/launch/confirm', { launchId: p.launchId });
    check('confirm idempotency: retry -> same signature, idempotent flag', () => { assert.equal(conf2.json.idempotent, true); assert.equal(conf2.json.signature, c.signature); });

    // === duplicate-launch protection: same requestKey never launches twice ===
    const dup = await api('/launch/prepare', { requestKey, name: 'dup', symbol: 'DUP', moduleId: 'hold-v1' });
    check('duplicate protection: same requestKey after confirm returns the SAME coin, no new mint', () => { assert.equal(dup.json.mint, p.mint); });

    // === receipts ===
    const rec = await api(`/coins/${p.mint}/receipts`, null, 'GET');
    check('GET /coins/:mint/receipts has exactly one launch receipt with a solscan link', () => {
      const launches = rec.json.receipts.filter((r) => r.kind === 'launch');
      assert.equal(launches.length, 1);
      assert.ok(launches[0].signature === c.signature); assert.ok(launches[0].solscan.startsWith('http'));
    });

    // === accrue fees, then run one epoch to verify distribution + 90/10 receipt ===
    await accrueFees(conn, phase0, trader, mint, global, 2);
    const modBefore = (await conn.getAccountInfo(moduleDest))?.lamports ?? 0;
    const buyBefore = (await conn.getAccountInfo(buybackDest))?.lamports ?? 0;
    const epoch = await runEpochOnce();
    const recAfter = await api(`/coins/${p.mint}/receipts`, null, 'GET');
    const dist = recAfter.json.receipts.find((r) => r.kind === 'distribute');
    check('epoch: a distribute receipt was written', () => { assert.ok(dist, 'no distribute receipt'); assert.ok(dist.solscan.startsWith('http')); });
    if (dist) {
      const modGot = (await conn.getAccountInfo(moduleDest)).lamports - modBefore;
      const buyGot = (await conn.getAccountInfo(buybackDest)).lamports - buyBefore;
      check('epoch: distribution is 90/10 (module 9000 bps, buyback 1000 bps, ±1 lamport)', () => {
        const total = modGot + buyGot;
        assert.ok(total > 0, 'nothing distributed');
        assert.ok(Math.abs(modGot * 10000 - total * 9000) <= 10000, `module ${modGot}/${total}`);
        assert.ok(Math.abs(buyGot * 10000 - total * 1000) <= 10000, `buyback ${buyGot}/${total}`);
      });
    }

    // === buyback is inert (no invented mint) ===
    const { buybackStatus } = await import('../src/modules/buybackBurn.mjs');
    check('buyback+burn is disabled while FEES_MINT_ADDRESS is null', () => {
      const s = buybackStatus();
      assert.equal(s.feesMintSet, false); assert.equal(s.active, false);
      assert.match(s.reason, /FEES_MINT_ADDRESS is null/);
    });
  } finally {
    server.close();
  }

  // ---- summary ----
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) { console.log('FAILURES:'); for (const f of failed) console.log(`  - ${f.name}: ${f.err}`); process.exit(1); }
  console.log('INTEGRATION PASS');
  process.exit(0);
}

// Generate real creator fees by trading, so the epoch has something to split.
async function accrueFees(conn, phase0, trader, mint, global, count) {
  const { pdas, ixBuyV2, ixCreateAtaIdempotent, ixInitUserVolumeAccumulator, decodeBondingCurve, quoteBuy, buildV0, WSOL, TOKEN_2022 } = phase0;
  // one-time trader setup
  const setup = [
    ixCreateAtaIdempotent({ payer: trader.publicKey, owner: trader.publicKey, mint, tokenProgram: TOKEN_2022 }),
    ixCreateAtaIdempotent({ payer: trader.publicKey, owner: trader.publicKey, mint: WSOL }),
  ];
  if (!(await conn.getAccountInfo(pdas.userVolumeAccumulator(trader.publicKey)))) setup.push(ixInitUserVolumeAccumulator({ payer: trader.publicKey, user: trader.publicKey }));
  await sendSigned(conn, buildV0, trader, setup);

  for (let i = 0; i < count; i++) {
    const curve = decodeBondingCurve((await conn.getAccountInfo(pdas.bondingCurve(mint))).data);
    const solIn = BigInt(2 * 1e9);
    const amount = (quoteBuy(curve, solIn) * 97n) / 100n;
    const ix = ixBuyV2({ mint, user: trader.publicKey, creator: curve.creator, feeRecipient: global.feeRecipient, buybackFeeRecipient: global.buybackFeeRecipients[0], amount, maxSolCost: (solIn * 115n) / 100n });
    await sendSigned(conn, buildV0, trader, [ix]);
  }
}
async function sendSigned(conn, buildV0, kp, instructions) {
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
  const tx = buildV0(kp.publicKey, instructions, blockhash);
  tx.sign([kp]);
  const sig = await conn.sendTransaction(tx, { skipPreflight: false });
  await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
  return sig;
}

main().catch((e) => { console.error('\nintegration aborted:', e.message); process.exit(1); });
