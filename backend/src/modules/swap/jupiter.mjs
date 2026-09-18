// Jupiter swap provider for the 10% buyback (SOL -> $FEES), used by
// modules/buybackBurn.mjs. INERT until you (a) set FEES_MINT_ADDRESS in
// lib/constants.mjs, (b) set BUYBACK_ENABLED=true, and (c) wire it with
// setSwapProvider(jupiterSwapProvider) — see modules/wireBuyback.mjs.
//
// It quotes SOL->$FEES via Jupiter's public API and returns the swap
// instructions for the buyback wallet to sign. It does NOT sign or send.
//
// ⚠️  UNTESTED against a live $FEES market. Before enabling: dry-run on a
//     canary with a tiny amount, confirm the received-$FEES amount matches the
//     quote within slippage, and confirm the buyback-signer policy (below).
//
// ⚠️  SIGNER POLICY: a Jupiter swap routes through third-party AMM programs that
//     are NOT on the crank/buyback allowlist in signer/core.mjs. Do not widen
//     that allowlist. Before enabling buyback, add a dedicated buyback signing
//     path that authorizes by NET EFFECT instead of program identity:
//        - the signing (buyback) wallet's SOL balance may decrease by at most
//          the epoch's buyback lamports + a fee cap;
//        - the transaction MUST include the $FEES BurnChecked instruction for
//          the full received amount;
//        - no token account authority is changed.
//     That keeps the buyback safe without trusting arbitrary programs.

import { PublicKey } from '@solana/web3.js';
import { config } from '../../config.mjs';
import { FEES_MINT_ADDRESS, WSOL } from '../../phase0.mjs';

const JUP = process.env.JUPITER_API_BASE || 'https://quote-api.jup.ag/v6';
const SLIPPAGE_BPS = Number(process.env.BUYBACK_SLIPPAGE_BPS ?? 100); // 1%

// Returns { feesAmount: bigint, instructions: TransactionInstruction[] }.
// lamportsIn is the SOL (in lamports) to spend on this buyback.
export const jupiterSwapProvider = {
  async quoteAndSwapSolToFees({ lamportsIn }) {
    if (!FEES_MINT_ADDRESS) throw new Error('jupiter provider called with FEES_MINT_ADDRESS unset');
    const amount = BigInt(lamportsIn).toString();

    const quoteUrl = `${JUP}/quote?inputMint=${WSOL.toBase58()}&outputMint=${FEES_MINT_ADDRESS}&amount=${amount}&slippageBps=${SLIPPAGE_BPS}&swapMode=ExactIn`;
    const quote = await (await fetch(quoteUrl)).json();
    if (!quote || quote.error || !quote.outAmount) throw new Error(`jupiter quote failed: ${quote?.error ?? 'no route'}`);

    const swapRes = await fetch(`${JUP}/swap-instructions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        quoteResponse: quote,
        userPublicKey: config.buybackDest.toBase58(),
        wrapAndUnwrapSol: true,
        // The burn is added by buybackBurn.mjs; keep Jupiter to the swap only.
      }),
    });
    const swap = await swapRes.json();
    if (!swap || swap.error) throw new Error(`jupiter swap-instructions failed: ${swap?.error}`);

    const toIx = (ix) => ({
      programId: new PublicKey(ix.programId),
      keys: ix.accounts.map((a) => ({ pubkey: new PublicKey(a.pubkey), isSigner: a.isSigner, isWritable: a.isWritable })),
      data: Buffer.from(ix.data, 'base64'),
    });
    const instructions = [
      ...(swap.computeBudgetInstructions ?? []).map(toIx),
      ...(swap.setupInstructions ?? []).map(toIx),
      toIx(swap.swapInstruction),
      ...(swap.cleanupInstruction ? [toIx(swap.cleanupInstruction)] : []),
    ];
    // NOTE: swap.addressLookupTableAddresses may be required to fit the tx; the
    // buyback tx builder must load and pass them. Handle when enabling buyback.
    return { feesAmount: BigInt(quote.outAmount), instructions, addressLookupTableAddresses: swap.addressLookupTableAddresses ?? [] };
  },
};
