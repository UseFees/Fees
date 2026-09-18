// Apply schema.sql. Idempotent (CREATE TABLE IF NOT EXISTS).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { pool } from '../src/db/pool.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const sql = readFileSync(join(root, 'schema.sql'), 'utf8');
await pool.query(sql);
console.log('schema applied');
await pool.end();
