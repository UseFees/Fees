// Signing core. Holds the launch and crank keypairs and per-launch ephemeral
// mint keypairs. It NEVER signs blindly: every launch message is deserialized,
// its accounts resolved through the ALT, and re-validated against the locked
// E3 invariants and the 90/10 split — using the signer's OWN buyback dest, not
// anything the caller claims. A compromised API cannot get an off-path or
// off-economics transaction signed.

import { Keypair, PublicKey, VersionedMessage, VersionedTransaction, SystemProgram } from '@solana/web3.js';
import { connection, assertCluster } from '../solanaClient.mjs';
import { config } from '../config.mjs';
import { pdas, measureSize, PUMP, FEES, AMM, TOKEN, TOKEN_2022, ATA_PROGRAM, SYSTEM } from '../phase0.mjs';
import { loadGlobal, loadAlt } from '../launch/alt.mjs';
import { validateLaunchInstructions, validateCompiledSize } from '../launch/validate.mjs';
import { loadKeypair } from './keys.mjs';
import { log } from '../logger.mjs';

const COMPUTE_BUDGET = new PublicKey('ComputeBudget111111111111111111111111111111');
const CRANK_ALLOWED_PROGRAMS = new Set([PUMP, FEES, AMM, TOKEN, TOKEN_2022, ATA_PROGRAM, SYSTEM, COMPUTE_BUDGET].map((k) => k.toBase58()));

// The Address Lookup Table program is required — E3 only fits with the 22-entry
// creator ALT, so init_alt / the ALT readiness flow must create and extend it
// through the crank signer. It is NOT added to the broad allowlist above: only
// the two ALT instructions the flow needs are permitted, and the destructive
// ones (freeze/deactivate/close) are still rejected, so the signer can never be
// used to disable a live table.
const ALT_PROGRAM = new PublicKey('AddressLookupTab1e1111111111111111111111111');
// AddressLookupTableInstruction tags (u32 LE at data[0]):
//   0 CreateLookupTable · 1 FreezeLookupTable · 2 ExtendLookupTable
//   3 DeactivateLookupTable · 4 CloseLookupTable
const ALT_CREATE = 0, ALT_EXTEND = 2;
const ALT_ALLOWED_TAGS = new Set([ALT_CREATE, ALT_EXTEND]);

// Pure, chain-free authorization check for anything the crank/buyback signer is
// asked to sign. Throws (with a .code) on the first violation. Exported so it
// can be unit-tested without a validator. `walletPubkey` is the signing wallet,
// used to scope the SystemProgram-transfer rule to its own balance.
export function assertCrankAllowed(instructions, walletPubkey) {
  for (const ix of instructions) {
    const pid = ix.programId.toBase58();
    if (pid === ALT_PROGRAM.toBase58()) {
      const tag = ix.data.length >= 4 ? ix.data.readUInt32LE(0) : -1;
      if (!ALT_ALLOWED_TAGS.has(tag)) {
        const e = new Error(`crank refused: Address Lookup Table instruction ${tag} not allowed (only create=0 / extend=2)`);
        e.code = 'alt_instruction_not_allowed'; throw e;
      }
      continue; // allowed ALT create/extend
    }
    if (!CRANK_ALLOWED_PROGRAMS.has(pid)) {
      const e = new Error(`crank refused: unknown program ${pid}`); e.code = 'program_not_allowed'; throw e;
    }
    if (pid === SystemProgram.programId.toBase58()) {
      const kind = ix.data.length >= 4 ? ix.data.readUInt32LE(0) : -1; // 2=transfer, 11=withdrawNonce
      const debitsWallet = walletPubkey && ix.keys[0]?.pubkey.equals(walletPubkey);
      if ((kind === 2 || kind === 11) && debitsWallet) {
        const e = new Error('crank refused: SystemProgram transfer/withdraw from the signing wallet'); e.code = 'system_transfer'; throw e;
      }
    }
  }
}

let _launch = null, _crank = null, _buyback = null;
function launchKp() { if (!_launch) _launch = loadKeypair({ path: config.signer.launchKeypairPath, json: config.signer.launchKeypairJson }, 'launch'); return _launch; }
function crankKp() { if (!_crank) _crank = loadKeypair({ path: config.signer.crankKeypairPath, json: config.signer.crankKeypairJson }, 'crank'); return _crank; }
// Loaded only if a buyback ever runs (buyback is disabled until $FEES exists).
function buybackKp() { if (!_buyback) _buyback = loadKeypairFromFile(config.buybackKeypairPath, 'buyback'); return _buyback; }

export function launchWalletPubkey() { return launchKp().publicKey.toBase58(); }
export function crankWalletPubkey() { return crankKp().publicKey.toBase58(); }

// Ephemeral per-launch mints, in memory only, TTL-bounded. If the signer
// restarts between prepare and confirm the intent has already expired.
const mints = new Map(); // launchId -> { kp, expiresAt }
function gcMints() { const now = Date.now(); for (const [id, m] of mints) if (m.expiresAt < now) mints.delete(id); }

export function newLaunchMint(launchId) {
  gcMints();
  const kp = Keypair.generate();
  mints.set(launchId, { kp, expiresAt: Date.now() + (config.launchIntentTtlSeconds + 30) * 1000 });
  return kp.publicKey.toBase58();
}

// Rebuild instruction objects from a compiled v0 message, resolving ALT keys,
// so validation runs on what will actually execute.
function messageToInstructions(message, accountKeys) {
  return message.compiledInstructions.map((ci) => ({
    programId: accountKeys.get(ci.programIdIndex),
    keys: ci.accountKeyIndexes.map((idx) => ({ pubkey: accountKeys.get(idx), isSigner: message.isAccountSigner(idx), isWritable: message.isAccountWritable(idx) })),
    data: Buffer.from(ci.data),
  }));
}

function shareholderFromUpdate(instructions) {
  const upd = instructions.find((ix) => ix.programId.equals(FEES) && ix.data.length >= 12 && ix.data.readUInt32LE(8) === 2);
  if (!upd) return null;
  const out = [];
  let o = 12;
  for (let i = 0; i < 2; i++) { out.push({ pubkey: new PublicKey(upd.data.subarray(o, o + 32)), shareBps: upd.data.readUInt16LE(o + 32) }); o += 34; }
  return out;
}

export async function signAndSubmitLaunch({ launchId, messageBase64 }) {
  await assertCluster();
  const stored = mints.get(launchId);
  if (!stored) { const e = new Error('no ephemeral mint for this launchId (expired or unknown); re-prepare'); e.code = 'mint_missing'; throw e; }

  const message = VersionedMessage.deserialize(Buffer.from(messageBase64, 'base64'));
  const global = await loadGlobal();
  const alt = await loadAlt(global);
  if (!alt.ok) { const e = new Error('signer: ALT unavailable'); e.code = 'alt_unavailable'; throw e; }
  const accountKeys = message.getAccountKeys({ addressLookupTableAccounts: [alt.table] });
  const instructions = messageToInstructions(message, accountKeys);

  // Determine module/buyback from the update instruction, but bind buyback to
  // the signer's OWN config — the caller cannot redirect the FEES 10%.
  const shares = shareholderFromUpdate(instructions);
  if (!shares) { const e = new Error('signer: no update_fee_shares_v2 found'); e.code = 'no_update'; throw e; }
  const buyback = shares.find((s) => s.pubkey.equals(config.buybackDest));
  const moduleDest = shares.find((s) => !s.pubkey.equals(config.buybackDest))?.pubkey;
  if (!buyback || buyback.shareBps !== 1000) { const e = new Error('signer: FEES 10% is not routed to the configured buyback dest'); e.code = 'buyback_mismatch'; throw e; }
  if (!moduleDest) { const e = new Error('signer: no module dest'); e.code = 'no_module'; throw e; }

  const semantics = validateLaunchInstructions({ instructions, launchWallet: launchKp().publicKey, mint: stored.kp.publicKey, moduleDest, buybackDest: config.buybackDest });
  const size = measureSize(new VersionedTransaction(message));
  const sizeCheck = validateCompiledSize({ sizeBytes: size.bytes, accountCount: accountKeys.length });
  if (!semantics.ok || !sizeCheck.ok) {
    const e = new Error(`signer refused: ${[...semantics.problems, ...sizeCheck.problems].join('; ')}`);
    e.code = 'validation_failed'; throw e;
  }

  // Sign against a FRESH blockhash fetched at sign time, not the stale one the
  // API compiled at prepare. Only recentBlockhash changes; the instructions,
  // accounts and ALT lookups are exactly what was validated above. This is what
  // eliminates the "block height exceeded" expiry between prepare and confirm.
  const { blockhash, lastValidBlockHeight } = await connection().getLatestBlockhash(config.rpcCommitment);
  message.recentBlockhash = blockhash;
  const tx = new VersionedTransaction(message);
  tx.sign([launchKp(), stored.kp]);

  // sendRawTransaction so the caller confirms with the exact tuple below. The
  // ephemeral mint is NOT deleted here: a retry re-signs the SAME mint with a
  // fresh blockhash, so no second mint can ever be created. create_v2 with an
  // existing mint fails, so at most one attempt can actually create the coin.
  const signature = await connection().sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 5 });
  log.info('launch signed and submitted', { launchId, signature, mint: stored.kp.publicKey.toBase58(), moduleDest: moduleDest.toBase58(), lastValidBlockHeight });
  return { signature, blockhash, lastValidBlockHeight, mint: stored.kp.publicKey.toBase58() };
}

// Release an ephemeral mint once the launch is confirmed (or abandoned). Safe to
// call more than once. Kept explicit so the API drops the secret promptly.
export function releaseLaunchMint(launchId) { mints.delete(launchId); }

// Crank signing (collect/distribute). These are permissionless on chain, so the
// crank wallet only pays fees; the rule is simply that it may not be tricked
// into an unknown program or a SystemProgram transfer out of its own balance.
export async function signAndSubmitCrank({ messageBase64, role = 'crank' }) {
  await assertCluster();
  const message = VersionedMessage.deserialize(Buffer.from(messageBase64, 'base64'));
  const global = await loadGlobal();
  const alt = await loadAlt(global);
  const accountKeys = message.getAccountKeys(alt.ok ? { addressLookupTableAccounts: [alt.table] } : undefined);
  const instructions = messageToInstructions(message, accountKeys);
  // The signing wallet may never be tricked into an unknown program, a
  // destructive ALT instruction, or a SystemProgram transfer out of its balance.
  const walletKp = role === 'buyback' ? buybackKp() : crankKp();
  assertCrankAllowed(instructions, walletKp.publicKey);
  const tx = new VersionedTransaction(message);
  tx.sign([walletKp]);
  const signature = await connection().sendTransaction(tx, { skipPreflight: false, maxRetries: 5 });
  log.info('crank signed and submitted', { role, signature });
  return { signature };
}
