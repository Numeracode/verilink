// control-plane/src/db/transaction.ts
import type pg from 'pg';
import { pool } from './client.js';

export { pool };

/**
 * Execute work inside a transaction. The client is automatically released
 * (even if work throws). Commit happens only if work returns without error.
 */
export async function withTransaction<T>(
  work: (client: pg.PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
