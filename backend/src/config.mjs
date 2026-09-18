// Central configuration and the production safety gates. Nothing else reads
// process.env directly. Booleans default to the SAFE value.

import { PublicKey } from '@solana/web3.js';
import { FEES_MINT_ADDRESS, MODULE_SHARE_BPS, FEES_SHARE_BPS } from './phase0.mjs';

const req = (k) => {
  const v = process.env[k];
  if (!v) throw new Error(`missing required env var ${k}`);
  return v;
};
const opt = (k, d) => process.env[k] ?? d;
const bool = (k, d = false) => {
  const v = process.env[k];
  return v == null ? d : v === 'true';
};
const int = (k, d) => (process.env[k] != null ? Number(process.env[k]) : d);
const pk = (k, required) => {
  const v = required ? req(k) : process.env[k];
  if (!v) return null;
  try { return new PublicKey(v); } catch { throw new Error(`env ${k} is not a valid pubkey: ${v}`); }
};

// The economics are locked in code, never in config. If anyone sets these env
// vars to something other than 9000/1000, the process refuses to start.
if (int('MODULE_SHARE_BPS', MODULE_SHARE_BPS) !== 9000 || int('FEES_SHARE_BPS', FEES_SHARE_BPS) !== 1000 || MODULE_SHARE_BPS !== 9000 || FEES_SHARE_BPS !== 1000) {
  throw new Error('the 90/10 split is locked at 9000/1000 bps and cannot be reconfigured');
}

export const config = {
  env: opt('NODE_ENV', 'development'),
  port: int('PORT', 8080),

  rpcUrl: req('RPC_URL'),
  rpcCommitment: opt('RPC_COMMITMENT', 'confirmed'),
  // Genesis hash the RPC must report before any write. Prevents a misconfigured
  // endpoint from launching on the wrong cluster. Mainnet by default.
  expectedGenesis: opt('EXPECTED_GENESIS', '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'),

  // The fixed FEES launch/creator wallet (public key only; the API never sees
  // the secret — that lives in the signer service).
  launchWallet: pk('LAUNCH_WALLET_PUBKEY', true),
  crankWallet: pk('CRANK_WALLET_PUBKEY', true),

  // The per-creator Address Lookup Table (22 entries, E3). Created once by
  // scripts/init_alt.mjs, then pinned here.
  altAddress: pk('LAUNCH_ALT_ADDRESS', false),

  // Destinations for the on-chain 90/10 split.
  moduleDestDefault: pk('MODULE_DEST_DEFAULT', false), // per-module override in DB
  buybackDest: pk('BUYBACK_DEST', true),               // FEES-side 10% sink

  // Signer boundary.
  signer: {
    mode: opt('SIGNER_MODE', 'http'),      // 'http' (separate process) or 'inprocess' (alpha only)
    url: opt('SIGNER_URL', 'http://127.0.0.1:8091'),
    token: process.env.SIGNER_TOKEN ?? null, // shared secret between API and signer
    launchKeypairPath: process.env.LAUNCH_KEYPAIR_PATH ?? null, // read by the signer service only
    crankKeypairPath: process.env.CRANK_KEYPAIR_PATH ?? null,
    // Railway/container deployments may provide the same 64-byte Solana secret
    // array directly as a protected env var so no shell/file bootstrap is needed.
    launchKeypairJson: process.env.LAUNCH_KEYPAIR_JSON ?? null,
    crankKeypairJson: process.env.CRANK_KEYPAIR_JSON ?? null,
    port: int('SIGNER_PORT', 8091),
    host: opt('SIGNER_HOST', '127.0.0.1'),
  },

  // Hard production gate. Launches and cranks are refused unless true.
  launchEnabled: bool('LAUNCH_ENABLED', false),
  // Per-launch dev-buy ceiling and default, in lamports.
  maxDevBuyLamports: int('MAX_DEV_BUY_LAMPORTS', 2_000_000_000), // 2 SOL
  defaultDevBuyLamports: int('DEFAULT_DEV_BUY_LAMPORTS', 500_000_000), // 0.5 SOL (E3)
  // Priority fee (micro-lamports per CU). 0 reproduces the E3 measurement; set
  // >0 for mainnet landing. The builder re-checks the 1232-byte limit either way.
  priorityFeeMicroLamports: int('LAUNCH_PRIORITY_FEE_MICROLAMPORTS', 0),
  launchComputeUnitLimit: int('LAUNCH_CU_LIMIT', 0), // 0 = no explicit limit (default budget)

  // A prepared launch is valid for this long before its blockhash expires.
  launchIntentTtlSeconds: int('LAUNCH_INTENT_TTL_SECONDS', 90),

  // 'pg' (production) or 'memory' (integration tests / dev; no Postgres needed).
  dbDriver: opt('DB_DRIVER', 'pg'),
  database: { url: opt('DB_DRIVER', 'pg') === 'memory' ? (process.env.DATABASE_URL ?? null) : req('DATABASE_URL') },

  // 10% buyback + permanent burn. Inert unless BOTH the real $FEES mint exists
  // (FEES_MINT_ADDRESS non-null in lib/constants.mjs) AND this is true. Default
  // false. There is no way to run a buyback against an invented mint.
  buybackEnabled: bool('BUYBACK_ENABLED', false),
  buybackKeypairPath: process.env.BUYBACK_KEYPAIR_PATH ?? null, // signer-only; controls BUYBACK_DEST

  epoch: {
    intervalMs: int('EPOCH_INTERVAL_MS', 3_600_000), // hourly
    minDistributableLamports: int('EPOCH_MIN_DISTRIBUTABLE_LAMPORTS', 1_000_000), // skip dust epochs
  },

  solscanBase: opt('SOLSCAN_BASE', 'https://solscan.io'),
  // 'mainnet' → no cluster suffix; 'devnet' → ?cluster=devnet on links.
  cluster: opt('CLUSTER', 'mainnet'),

  feesMintAddress: FEES_MINT_ADDRESS, // stays null until $FEES exists; buyback refuses meanwhile
  apiToken: process.env.API_TOKEN ?? null, // bearer the frontend/BFF presents
};

export function assertWritable() {
  if (!config.launchEnabled) {
    const e = new Error('LAUNCH_ENABLED is false: writes are disabled');
    e.status = 503; e.code = 'writes_disabled';
    throw e;
  }
}
