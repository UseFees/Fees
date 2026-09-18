// One shared Connection, the cluster-safety assertion every write path runs
// first, and a NON-THROWING confirmation that decides landed/expired by chain
// state rather than letting confirmTransaction throw on block-height expiry.

import { Connection } from '@solana/web3.js';
import { config } from './config.mjs';

let _conn = null;
export function connection() {
  if (!_conn) _conn = new Connection(config.rpcUrl, { commitment: config.rpcCommitment });
  return _conn;
}

let _genesisChecked = false;
export async function assertCluster() {
  if (_genesisChecked) return;
  const genesis = await connection().getGenesisHash();
  if (genesis !== config.expectedGenesis) {
    throw new Error(`RPC genesis ${genesis} != expected ${config.expectedGenesis}; refusing to operate on the wrong cluster`);
  }
  _genesisChecked = true;
}

const landedStatus = (st) => Boolean(st) && !st.err && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized' || st.confirmations != null);

// Wait for `signature` using the EXACT {signature, lastValidBlockHeight} tuple
// of the submitted transaction, polling signature status and the current block
// height. Never throws on expiry — it returns a decision:
//   { landed:true,  err:null }        confirmed
//   { landed:true,  err:<...> }       executed but failed on chain
//   { landed:false, status:'expired_not_landed' }   block height passed, tx not found
//   { landed:false, status:'timeout' }              gave up before expiry (retryable)
// On expiry it does a final searchTransactionHistory lookup so a tx that DID
// land right at the boundary is still reported as landed.
export async function confirmOrCheckSignature(conn, { signature, lastValidBlockHeight, timeoutMs = 60_000, pollMs = 500, commitment = config.rpcCommitment }) {
  const start = Date.now();
  for (;;) {
    let st;
    try { st = (await conn.getSignatureStatuses([signature], { searchTransactionHistory: true })).value?.[0]; } catch { st = undefined; }
    if (st?.err) return { landed: true, err: st.err, status: 'failed' };
    if (landedStatus(st)) return { landed: true, err: null, status: 'confirmed' };

    let height = null;
    try { height = await conn.getBlockHeight(commitment); } catch { height = null; }
    if (height != null && height > lastValidBlockHeight) {
      let st2;
      try { st2 = (await conn.getSignatureStatuses([signature], { searchTransactionHistory: true })).value?.[0]; } catch { st2 = undefined; }
      if (st2?.err) return { landed: true, err: st2.err, status: 'failed' };
      if (landedStatus(st2)) return { landed: true, err: null, status: 'confirmed' };
      return { landed: false, err: null, status: 'expired_not_landed' };
    }
    if (Date.now() - start > timeoutMs) return { landed: false, err: null, status: 'timeout' };
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

export async function getTx(signature) {
  return connection().getTransaction(signature, { commitment: config.rpcCommitment, maxSupportedTransactionVersion: 0 });
}

// Convenience for scripts (init_alt): confirm or throw. Uses the same
// non-throwing core, then returns the transaction if it landed.
export async function confirmSignature(signature, _blockhash, lastValidBlockHeight) {
  const r = await confirmOrCheckSignature(connection(), { signature, lastValidBlockHeight });
  if (!r.landed) throw new Error(`transaction ${signature} did not land (${r.status})`);
  if (r.err) throw new Error(`transaction ${signature} failed on chain: ${JSON.stringify(r.err)}`);
  return getTx(signature);
}
