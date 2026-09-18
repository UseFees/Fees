// The FEES buyback module — the 10% side. It delegates to the real buyback+burn
// executor, which is HARD DISABLED until the $FEES mint exists AND
// BUYBACK_ENABLED=true AND a swap provider is wired (see buybackBurn.mjs). Until
// then it only records that the 10% is accruing in buyback_dest.
//
// $FEES is never invented here: FEES_MINT_ADDRESS lives in lib/constants.mjs and
// stays null until the real mint ships.

import { registerModule } from './executor.mjs';
import { executeBuybackAndBurn, buybackStatus } from './buybackBurn.mjs';
import { log } from '../logger.mjs';

registerModule('buyback', {
  kind: 'buyback',
  status: buybackStatus,
  async onDistribution(ctx) {
    const summary = await executeBuybackAndBurn(ctx); // returns deferred summary when disabled; never throws for being disabled
    if (!summary.executed) {
      log.warn('buyback deferred', { coin: ctx.coin.mint, reason: summary.reason, accruedLamports: summary.accruedLamports });
      return { kind: 'buyback', executed: false, reason: summary.reason, epochIndex: ctx.epochIndex, accruedLamports: summary.accruedLamports };
    }
    return { kind: 'buyback', executed: true, feesBurned: summary.feesBurned, signature: summary.signature, epochIndex: ctx.epochIndex };
  },
});
