// Safety rails for any experiment that can write to mainnet.
//
// Rules enforced here, not by convention:
//   - mainnet writes are off unless ALLOW_MAINNET_WRITES=true
//   - every mainnet write is capped per transaction and in total
//   - the plan must be printed and acknowledged before anything is submitted
//   - keys are read from files outside the repo, never from source or argv

import { readFileSync, appendFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Keypair } from '@solana/web3.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SPEND_LOG = join(ROOT, 'logs', 'mainnet-spend.log');

export function isMainnet(cluster) {
  return cluster === 'mainnet-beta' || cluster === 'mainnet';
}

export function loadKeypair(envVar) {
  const path = process.env[envVar];
  if (!path) throw new Error(`${envVar} is not set. See .env.example.`);
  if (path.startsWith(ROOT)) {
    throw new Error(`${envVar} points inside the repo. Keys must live outside it.`);
  }
  if (!existsSync(path)) throw new Error(`${envVar} points at a missing file: ${path}`);
  const secret = JSON.parse(readFileSync(path, 'utf8'));
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}

// Print exactly what will happen, the maximum SOL at risk, and why mainnet is
// required. Refuses to proceed unless the operator has explicitly approved.
export function assertMainnetApproved({ cluster, plan, maxLamports, whyMainnet }) {
  if (!isMainnet(cluster)) return;

  if (process.env.ALLOW_MAINNET_WRITES !== 'true') {
    throw new Error('mainnet writes are disabled. Set ALLOW_MAINNET_WRITES=true only after approval.');
  }
  const perTx = Number(process.env.MAX_MAINNET_LAMPORTS_PER_TX ?? 0);
  const total = Number(process.env.MAX_MAINNET_LAMPORTS_TOTAL ?? 0);
  if (!perTx || !total) throw new Error('mainnet caps are not configured.');
  if (maxLamports > perTx) {
    throw new Error(`plan risks ${maxLamports} lamports, over the per-tx cap of ${perTx}.`);
  }
  if (spentSoFar() + maxLamports > total) {
    throw new Error(`plan would exceed the total mainnet cap of ${total} lamports.`);
  }
  if (!whyMainnet) throw new Error('a mainnet write must state why mainnet is required.');

  console.log('\n--- MAINNET WRITE PLAN ---');
  for (const line of plan) console.log(`  ${line}`);
  console.log(`  max at risk: ${maxLamports} lamports (${(maxLamports / 1e9).toFixed(6)} SOL)`);
  console.log(`  why mainnet: ${whyMainnet}`);
  console.log('--------------------------\n');

  if (process.env.MAINNET_PLAN_ACK !== 'approved') {
    throw new Error('plan printed. Re-run with MAINNET_PLAN_ACK=approved to submit.');
  }
}

export function logSpend(lamports, note) {
  appendFileSync(SPEND_LOG, `${new Date().toISOString()}\t${lamports}\t${note}\n`);
}

function spentSoFar() {
  if (!existsSync(SPEND_LOG)) return 0;
  return readFileSync(SPEND_LOG, 'utf8')
    .split('\n')
    .filter(Boolean)
    .reduce((sum, line) => sum + Number(line.split('\t')[1] ?? 0), 0);
}
