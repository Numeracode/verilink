// control-plane/src/db/client.ts
import pg from 'pg';
import { config } from '../config.js';
import { logger } from '../shared/logger.js';

function createPool(): pg.Pool {
  const p = new pg.Pool({
    connectionString: config.database.url,
    max: config.database.poolMax,
    idleTimeoutMillis: config.database.poolIdleTimeoutMillis,
    connectionTimeoutMillis: config.database.poolConnectionTimeoutMillis,
  });
  p.on('error', (err) => {
    logger.error({ err }, 'Unexpected idle client error');
  });
  return p;
}

export let pool = createPool();

/** Recreate the singleton after `pool.end()` (multi-suite integration harness). */
export function recreatePool(): void {
  pool = createPool();
}