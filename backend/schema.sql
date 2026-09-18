-- FEES backend schema (Postgres). Append-only where it matters (receipts,
-- epochs); mutable status only where a lifecycle demands it (launch_intents,
-- coins). The 90/10 economics are NOT represented as configurable columns —
-- they are fixed in code and enforced on chain.

CREATE TABLE IF NOT EXISTS modules (
  id            TEXT PRIMARY KEY,              -- slug, e.g. 'hold-v1'
  name          TEXT NOT NULL,
  kind          TEXT NOT NULL,                 -- 'passthrough' | 'buyback' | custom
  module_dest   TEXT NOT NULL,                 -- pubkey receiving the on-chain 90%
  config        JSONB NOT NULL DEFAULT '{}',
  enabled       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS alt_tables (
  table_address TEXT PRIMARY KEY,
  creator       TEXT NOT NULL,                 -- launch wallet pubkey
  entries       JSONB NOT NULL,
  entry_count   INT NOT NULL,
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  refreshed_at  TIMESTAMPTZ
);

-- One row per /launch/prepare. request_key gives idempotency + duplicate-launch
-- protection: the same key always maps to the same intent and, once confirmed,
-- the same coin.
CREATE TABLE IF NOT EXISTS launch_intents (
  id            UUID PRIMARY KEY,
  request_key   TEXT NOT NULL UNIQUE,
  status        TEXT NOT NULL,                 -- prepared | confirming | confirmed | failed | expired
  module_id     TEXT NOT NULL REFERENCES modules(id),
  params        JSONB NOT NULL,                -- {name,symbol,uri,devBuyLamports,moduleDest}
  mint          TEXT NOT NULL,                 -- ephemeral mint pubkey (secret lives only in the signer)
  message_b64   TEXT NOT NULL,                 -- unsigned v0 message the signer will sign
  blockhash     TEXT NOT NULL,
  last_valid_block_height BIGINT NOT NULL,
  size_bytes    INT NOT NULL,
  account_count INT NOT NULL,
  expires_at    TIMESTAMPTZ NOT NULL,
  signature     TEXT,                          -- set on confirm
  error         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS coins (
  id            UUID PRIMARY KEY,
  mint          TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  symbol        TEXT NOT NULL,
  uri           TEXT,
  launch_wallet TEXT NOT NULL,
  sharing_config TEXT NOT NULL,                -- bonding_curve.creator after launch
  sharing_vault TEXT NOT NULL,                 -- creator vault the split accrues into
  bonding_curve TEXT NOT NULL,
  module_id     TEXT NOT NULL REFERENCES modules(id),
  module_dest   TEXT NOT NULL,                 -- 9000 bps
  buyback_dest  TEXT NOT NULL,                 -- 1000 bps
  launch_signature TEXT NOT NULL,
  launch_slot   BIGINT,
  intent_id     UUID REFERENCES launch_intents(id),
  status        TEXT NOT NULL DEFAULT 'live',  -- live | graduated | halted
  split_verified BOOLEAN NOT NULL DEFAULT FALSE, -- creator==sharing_config && admin_revoked
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Hourly epochs. One row per (epoch_index) globally; per-coin distribution is in
-- epoch_distributions.
CREATE TABLE IF NOT EXISTS epochs (
  epoch_index   BIGINT PRIMARY KEY,
  started_at    TIMESTAMPTZ NOT NULL,
  ended_at      TIMESTAMPTZ,
  status        TEXT NOT NULL DEFAULT 'open',  -- open | running | closed | failed
  coins_processed INT NOT NULL DEFAULT 0,
  lamports_distributed BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS epoch_distributions (
  id            UUID PRIMARY KEY,
  epoch_index   BIGINT NOT NULL REFERENCES epochs(epoch_index),
  coin_id       UUID NOT NULL REFERENCES coins(id),
  distributed_lamports BIGINT NOT NULL DEFAULT 0,
  module_lamports BIGINT NOT NULL DEFAULT 0,   -- 90%
  buyback_lamports BIGINT NOT NULL DEFAULT 0,  -- 10%
  signature     TEXT,
  status        TEXT NOT NULL,                 -- distributed | skipped_dust | failed
  error         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (epoch_index, coin_id)                -- one distribution per coin per epoch
);

-- Append-only ledger of every on-chain action, for receipts and audit.
CREATE TABLE IF NOT EXISTS receipts (
  id            UUID PRIMARY KEY,
  kind          TEXT NOT NULL,                 -- launch | distribute | collect | alt_create | alt_refresh
  coin_id       UUID REFERENCES coins(id),
  epoch_index   BIGINT,
  signature     TEXT NOT NULL,
  slot          BIGINT,
  lamports      BIGINT,
  fee_lamports  BIGINT,
  payload       JSONB NOT NULL DEFAULT '{}',
  solscan_url   TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS receipts_coin_idx ON receipts (coin_id, created_at DESC);
CREATE INDEX IF NOT EXISTS receipts_sig_idx ON receipts (signature);
CREATE INDEX IF NOT EXISTS coins_module_idx ON coins (module_id);
