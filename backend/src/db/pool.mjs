import pg from 'pg';
import { config } from '../config.mjs';

export const pool = new pg.Pool({ connectionString: config.database.url, max: 10 });

export async function query(text, params) {
  const res = await pool.query(text, params);
  return res.rows;
}
export async function one(text, params) {
  const rows = await query(text, params);
  return rows[0] ?? null;
}
export async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}
