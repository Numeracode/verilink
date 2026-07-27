// control-plane/src/db/migrate.ts
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { pool } from './client.js';
import { logger } from '../shared/logger.js';

const MIGRATIONS_DIR = join(import.meta.dirname, '../../migrations');
const LOCK_ID = 8392017; // different from Whimsy's 7745836
const TRACKING_TABLE = '_verilink_migrations';

interface Migration {
  name: string;
  sql: string;
  checksum: string;
}

function discoverMigrations(): Migration[] {
  const entries = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort((a, b) => {
      const na = parseInt(a.split('_')[0], 10);
      const nb = parseInt(b.split('_')[0], 10);
      return na - nb;
    });

  // Validate consecutive numbering starting at 1
  for (let i = 0; i < entries.length; i++) {
    const expected = String(i + 1).padStart(3, '0');
    if (!entries[i].startsWith(expected)) {
      throw new Error(
        `Migration gap: expected ${expected}_*, found ${entries[i]}`
      );
    }
  }

  return entries.map((name) => {
    const sql = readFileSync(join(MIGRATIONS_DIR, name, 'migration.sql'), 'utf-8');
    const checksum = createHash('sha256').update(sql).digest('hex');
    return { name, sql, checksum };
  });
}

export async function runMigrations(): Promise<void> {
  const client = await pool.connect();
  try {
    // Acquire advisory lock (blocks concurrent migration runs)
    await client.query('SET lock_timeout = \'30s\'');
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_ID]);

    // Create tracking table if not exists
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.${TRACKING_TABLE} (
        name TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        checksum TEXT NOT NULL
      )
    `);

    const migrations = discoverMigrations();
    const { rows: applied } = await client.query(
      `SELECT name, checksum FROM public.${TRACKING_TABLE} ORDER BY name`
    );
    const appliedMap = new Map(applied.map((r) => [r.name, r.checksum]));

    // Drift detection: applied migrations that no longer have files
    for (const name of appliedMap.keys()) {
      if (!migrations.find((m) => m.name === name)) {
        throw new Error(
          `Migration ${name} was applied but no migration file found — possible drift`
        );
      }
    }

    for (const migration of migrations) {
      if (appliedMap.has(migration.name)) {
        // Verify checksum hasn't changed
        const existing = appliedMap.get(migration.name);
        if (existing !== migration.checksum) {
          throw new Error(
            `Migration ${migration.name} checksum mismatch: expected ${existing}, got ${migration.checksum}. ` +
            'Was the migration file modified after it was applied?'
          );
        }
        continue; // already applied
      }

      logger.info(`Applying migration: ${migration.name}`);
      await client.query('BEGIN');
      try {
        await client.query(migration.sql);
        await client.query(
          `INSERT INTO public.${TRACKING_TABLE} (name, checksum) VALUES ($1, $2)`,
          [migration.name, migration.checksum]
        );
        await client.query('COMMIT');
        logger.info(`Applied: ${migration.name}`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${migration.name} failed: ${err}`);
      }
    }

    logger.info(`All ${migrations.length} migrations applied.`);
  } finally {
    // Release advisory lock
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]);
    client.release();
  }
}

// Allow direct execution: tsx src/db/migrate.ts
if (process.argv[1] && process.argv[1].endsWith('migrate.ts')) {
  const { assertDatabaseConfigured } = await import('../config.js');
  assertDatabaseConfigured();
  runMigrations()
    .then(() => process.exit(0))
    .catch((err) => {
      logger.error(err);
      process.exit(1);
    });
}
