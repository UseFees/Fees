// Create/update one module from SEED_MODULE_* env vars. A coin cannot launch
// without a module (its 90% needs a destination).
import { PublicKey } from '@solana/web3.js';
import { repo } from '../src/db/repo.mjs';
import { pool } from '../src/db/pool.mjs';

const id = process.env.SEED_MODULE_ID || 'hold-v1';
const dest = process.env.SEED_MODULE_DEST;
if (!dest) { console.error('SEED_MODULE_DEST is required'); process.exit(1); }
new PublicKey(dest); // validate

const m = await repo.upsertModule({
  id,
  name: process.env.SEED_MODULE_NAME || 'Hold (passthrough)',
  kind: process.env.SEED_MODULE_KIND || 'passthrough',
  moduleDest: dest,
  config: {},
  enabled: true,
});
console.log('module upserted:', { id: m.id, kind: m.kind, moduleDest: m.module_dest });
await pool.end();
