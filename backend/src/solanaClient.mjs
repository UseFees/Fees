// One shared Connection, plus the cluster-safety assertion every write path
// runs first. The genesis-hash check is the production analogue of Phase 0's
// local-cluster guard: it refuses to operate against the wrong cluster.

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

export async function confirmSignature(signature, blockhash, lastValidBlockHeight) {
  const conn = connection();
  await conn.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, config.rpcCommitment);
  return conn.getTransaction(signature, { commitment: config.rpcCommitment, maxSupportedTransactionVersion: 0 });
}
