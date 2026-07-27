// control-plane/src/db/client.ts
import pg from 'pg';
import { config } from '../config.js';
import { logger } from '../shared/logger.js';

export const pool = new pg.Pool({
  connectionString: config.database.url,
  max: config.database.poolMax,
  idleTimeoutMillis: config.database.poolIdleTimeoutMillis,
  connectionTimeoutMillis: config.database.poolConnectionTimeoutMillis,
});

pool.on('error', (err) => {
  logger.error({ err }, 'Unexpected idle client error');
});
