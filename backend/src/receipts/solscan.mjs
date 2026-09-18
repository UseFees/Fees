// Receipt/link builders. Solscan is the canonical explorer for the receipts the
// frontend renders.

import { config } from '../config.mjs';

const suffix = config.cluster === 'mainnet' ? '' : `?cluster=${config.cluster}`;

export const solscan = {
  tx: (signature) => `${config.solscanBase}/tx/${signature}${suffix}`,
  account: (address) => `${config.solscanBase}/account/${address}${suffix}`,
  token: (mint) => `${config.solscanBase}/token/${mint}${suffix}`,
};

// Shape a receipt object for both DB persistence and the API response.
export function receiptOf({ kind, coinId, epochIndex, signature, slot, lamports, feeLamports, payload }) {
  return {
    kind, coinId, epochIndex, signature, slot, lamports, feeLamports,
    payload: payload ?? {},
    solscanUrl: solscan.tx(signature),
  };
}
