// The 10% FEES buyback + PERMANENT burn.
//
// Flow, per coin per epoch, on the accumulated buyback_dest balance:
//   1. swap the buyback SOL into $FEES (via an injected swap provider)
//   2. BURN the received $FEES with the SPL Token Burn instruction — this
//      reduces total supply forever; it is not a transfer to a dead address.
//   3. record a receipt.
//
// HARD DISABLED until BOTH:
//   - FEES_MINT_ADDRESS is set (the real $FEES mint, in lib/constants.mjs), and
//   - BUYBACK_ENABLED=true.
// There is deliberately NO default swap provider: even with the mint set, the
// executor refuses until a real swap route is wired, so nothing can run against
// an invented mint or an unaudited swap. The burn instruction itself is real and
// correct and can be unit-tested offline once a mint exists.

import { PublicKey, TransactionInstruction } from '@solana/web3.js';
import { config } from '../config.mjs';
import { FEES_MINT_ADDRESS, TOKEN, pdas, buildV0 } from '../phase0.mjs';
import { connection, confirmSignature } from '../solanaClient.mjs';
import { signer } from '../signer/index.mjs';
import { receiptOf } from '../receipts/solscan.mjs';
import { repo } from '../db/repo.mjs';
import { log } from '../logger.mjs';

// SPL Token BurnChecked (instruction 15): permanently reduces supply.
// accounts: [ tokenAccount(writable), mint(writable), authority(signer) ]
// data: [15, amount:u64 LE, decimals:u8]
export function ixBurnChecked({ tokenAccount, mint, authority, amount, decimals }) {
  const data = Buffer.alloc(1 + 8 + 1);
  data.writeUInt8(15, 0);
  data.writeBigUInt64LE(BigInt(amount), 1);
  data.writeUInt8(decimals, 9);
  return new TransactionInstruction({
    programId: TOKEN,
    keys: [
      { pubkey: tokenAccount, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
    ],
    data,
  });
}

// A swap provider must implement quoteAndSwapSolToFees({ lamportsIn }) and
// return { feesAmount, instructions, signers? }. None is wired by default.
let swapProvider = null;
export function setSwapProvider(p) { swapProvider = p; }

function feesMint() {
  if (!FEES_MINT_ADDRESS) return null;
  return new PublicKey(FEES_MINT_ADDRESS);
}

export function buybackStatus() {
  return {
    feesMintSet: Boolean(FEES_MINT_ADDRESS),
    enabled: config.buybackEnabled,
    swapProviderWired: Boolean(swapProvider),
    active: Boolean(FEES_MINT_ADDRESS) && config.buybackEnabled && Boolean(swapProvider),
    reason: !FEES_MINT_ADDRESS ? 'FEES_MINT_ADDRESS is null ($FEES not created)'
      : !config.buybackEnabled ? 'BUYBACK_ENABLED is false'
      : !swapProvider ? 'no swap provider wired'
      : 'active',
  };
}

// Execute buyback + burn for one coin/epoch. Returns a summary; throws only on a
// genuine execution error (never merely because it is disabled — that returns a
// deferred summary so the epoch worker keeps going).
export async function executeBuybackAndBurn(ctx) {
  const mint = feesMint();
  const status = buybackStatus();
  if (!status.active) {
    log.warn('buyback+burn inert', { coin: ctx.coin.mint, ...status, accruedLamports: String(ctx.buybackLamports) });
    return { executed: false, ...status, accruedLamports: String(ctx.buybackLamports) };
  }

  // 1. swap the freshly-distributed buyback lamports into $FEES.
  const { feesAmount, instructions: swapIx } = await swapProvider.quoteAndSwapSolToFees({ lamportsIn: ctx.buybackLamports });
  if (!feesAmount || feesAmount <= 0n) return { executed: false, reason: 'swap returned zero $FEES', accruedLamports: String(ctx.buybackLamports) };

  // 2. burn every $FEES received. buyback wallet == BUYBACK_DEST controls the ATA.
  const decimals = (await connection().getParsedAccountInfo(mint)).value?.data?.parsed?.info?.decimals ?? 6;
  const buybackAta = pdas.ata(config.buybackDest, mint, TOKEN);
  const burnIx = ixBurnChecked({ tokenAccount: buybackAta, mint, authority: config.buybackDest, amount: feesAmount, decimals });

  const { blockhash, lastValidBlockHeight } = await connection().getLatestBlockhash(config.rpcCommitment);
  const tx = buildV0(config.buybackDest, [...swapIx, burnIx], blockhash);
  // Signed by the buyback signer (controls BUYBACK_DEST). The crank/launch keys
  // are NOT used here.
  const { signature } = await signer.signAndSubmitCrank({ messageBase64: Buffer.from(tx.message.serialize()).toString('base64'), role: 'buyback' });
  const confirmed = await confirmSignature(signature, blockhash, lastValidBlockHeight);

  await repo.insertReceipt(receiptOf({
    kind: 'buyback_burn', coinId: ctx.coin.id, epochIndex: ctx.epochIndex, signature, slot: confirmed?.slot ?? null,
    lamports: String(ctx.buybackLamports), payload: { feesBurned: feesAmount.toString(), mint: FEES_MINT_ADDRESS, burnedPermanently: true },
  }));
  log.info('buyback+burn executed', { coin: ctx.coin.mint, feesBurned: feesAmount.toString(), signature });
  return { executed: true, feesBurned: feesAmount.toString(), signature };
}
