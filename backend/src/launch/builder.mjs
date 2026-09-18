// Production launch transaction builder. This is a thin, deterministic wrapper
// over the E3-proven composition in lib/compose.mjs — it changes nothing about
// the instruction set, only adds the production concerns: the creator ALT, an
// optional priority fee, first-launch user_volume_accumulator handling, and a
// full re-validation of the compiled result before it is ever offered to a
// signer.

import { Keypair, ComputeBudgetProgram, VersionedTransaction } from '@solana/web3.js';
import { connection } from '../solanaClient.mjs';
import { config } from '../config.mjs';
import {
  atomicLaunchInstructions, buildV0, measureSize, measureAccounts, serializedSizeV0,
  projectV0Size, pdas, WSOL, TOKEN,
} from '../phase0.mjs';
import { loadGlobal, loadAlt } from './alt.mjs';
import { validateLaunchInstructions, validateCompiledSize } from './validate.mjs';

// Decide once per process whether buy_v2 needs a prior init_user_volume_accumulator
// for this launch wallet (true only before its first-ever pump trade).
let _uvaInit = null;
async function needsUvaInit() {
  if (_uvaInit != null) return _uvaInit;
  const info = await connection().getAccountInfo(pdas.userVolumeAccumulator(config.launchWallet));
  _uvaInit = info == null;
  return _uvaInit;
}
export function resetUvaCache() { _uvaInit = null; }

// Build the launch: returns everything the intent needs to persist and confirm.
// `mintPubkey` is the ephemeral mint the SIGNER generated for this launch (the
// mint is a required signer on create_v2; its secret never leaves the signer).
export async function buildLaunch({ name, symbol, uri, devBuyLamports, moduleDest, mintPubkey }) {
  const global = await loadGlobal();
  const alt = await loadAlt(global);
  if (!alt.ok) {
    const e = new Error(`launch ALT is not usable: ${alt.missing.join(', ')}. Run npm run init-alt (or refresh it).`);
    e.status = 503; e.code = 'alt_unavailable';
    throw e;
  }

  const buybackDest = config.buybackDest;
  const includeUvaInit = await needsUvaInit();

  const { instructions: core } = atomicLaunchInstructions({
    order: 'SHARES_THEN_BUY', // locked (E3)
    mint: mintPubkey,
    creator: config.launchWallet,
    global,
    name, symbol, uri,
    devBuyLamports: BigInt(devBuyLamports),
    shareholders: [
      { address: moduleDest, shareBps: 9000 },
      { address: buybackDest, shareBps: 1000 },
    ],
    includeUvaInit,
    cuLimit: 0, // priority fee handled below so we control ordering and bytes
    sendHolderRewardFlag: false,
  });

  // Optional priority fee for mainnet landing. Prepended; both instructions add
  // ~48 bytes total incl. the compute-budget program id (one static key,
  // amortised). The 1232-byte check below is authoritative regardless.
  const preface = [];
  if (config.launchComputeUnitLimit > 0) preface.push(ComputeBudgetProgram.setComputeUnitLimit({ units: config.launchComputeUnitLimit }));
  if (config.priorityFeeMicroLamports > 0) preface.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: config.priorityFeeMicroLamports }));
  const instructions = [...preface, ...core];

  // Compile with the creator ALT and measure the real thing.
  const { blockhash, lastValidBlockHeight } = await connection().getLatestBlockhash(config.rpcCommitment);
  const tx = buildV0(config.launchWallet, instructions, blockhash, [alt.table]);
  const size = measureSize(tx);
  const accounts = measureAccounts(tx);
  const compression = { staticAccounts: accounts.static, lookupAccounts: accounts.fromLookupTables, compressed: accounts.fromLookupTables > 0 };

  // Independent re-validation: semantics AND size. The signer runs the same
  // semantic check again on the bytes it is asked to sign.
  const semantics = validateLaunchInstructions({ instructions, launchWallet: config.launchWallet, mint: mintPubkey, moduleDest, buybackDest });
  const sizeCheck = validateCompiledSize({ sizeBytes: size.bytes, accountCount: accounts.total });
  if (!semantics.ok || !sizeCheck.ok) {
    const e = new Error(`launch build failed validation: ${[...semantics.problems, ...sizeCheck.problems].join('; ')}`);
    e.status = 500; e.code = 'launch_invalid';
    throw e;
  }
  if (!compression.compressed) {
    const e = new Error('launch did not compress against the ALT (table not applied); refusing an over-size build');
    e.status = 503; e.code = 'alt_not_applied';
    throw e;
  }

  const projection = projectV0Size(instructions, config.launchWallet, new Set(alt.table.state.addresses.map((a) => a.toBase58())));
  const sharingConfig = pdas.sharingConfig(mintPubkey);
  const bondingCurve = pdas.bondingCurve(mintPubkey);

  return {
    mint: mintPubkey,
    sharingConfig,
    bondingCurve,
    sharingVault: pdas.creatorVault(sharingConfig),
    // serialized UNSIGNED message for the signer to re-decode and sign
    messageBase64: Buffer.from(tx.message.serialize()).toString('base64'),
    blockhash, lastValidBlockHeight,
    order: semantics.order,
    limits: {
      sizeBytes: size.bytes, sizeLimit: size.limit, accountCount: accounts.total,
      projectionBytes: projection.bytes, compression,
    },
    devBuyLamports: String(devBuyLamports),
    includeUvaInit,
    instructionNames: semantics.order,
  };
}
