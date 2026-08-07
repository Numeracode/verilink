import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import assert from 'node:assert';
import pg from 'pg';

const { Pool } = pg;

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '../../migrations');

function redactDatabaseUrl(urlStr: string): string {
  try {
    const u = new URL(urlStr);
    if (u.password) {
      u.password = '***';
    }
    return u.toString();
  } catch {
    return '[invalid DATABASE_URL]';
  }
}

function assertSafeVerilinkTestDb(urlStr: string): void {
  // Safety: integration tests must not truncate arbitrary DBs.
  // We only allow the dedicated local test DB: verilink_test on localhost.
  const u = new URL(urlStr);
  const hostOk = u.hostname === '127.0.0.1' || u.hostname === 'localhost';
  const dbName = u.pathname.replace(/^\//, '');
  const dbOk = dbName === 'verilink_test';

  // pg/libpq connection strings allow certain query-string keys (or URL params)
  // to override parts of the effective connection target. For truncation safety,
  // reject any target-overriding parameters explicitly.
  const disallowedOverrideKeys = [
    'host',
    'database',
    'dbname',
    'port',
    'user',
    'password',
  ] as const;

  for (const key of disallowedOverrideKeys) {
    if (u.searchParams.has(key)) {
      assert.fail(
        `Refusing to run VeriLink integration DB helpers against DATABASE_URL=${redactDatabaseUrl(urlStr)}. ` +
          `Detected disallowed DATABASE_URL override parameter: ${key}`
      );
    }
  }

  if (!hostOk || !dbOk) {
    assert.fail(
      `Refusing to run VeriLink integration DB helpers against DATABASE_URL=${redactDatabaseUrl(urlStr)}. ` +
        `Expected host=127.0.0.1|localhost and db=verilink_test.`
    );
  }
}

/**
 * Connects to DATABASE_URL and applies control-plane migrations if needed.
 * Callers must set DATABASE_URL (and ideally API_KEY_HMAC_SECRET) before
 * importing application modules that freeze config.
 */
export async function setupTestDb(): Promise<pg.Pool> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL is required for control-plane integration tests');
  }
  assertSafeVerilinkTestDb(url);
  if (!process.env.API_KEY_HMAC_SECRET) {
    process.env.API_KEY_HMAC_SECRET = 'test-hmac-secret-for-integration';
  }

  const pool = new Pool({ connectionString: url });

  await pool.query(`
    CREATE TABLE IF NOT EXISTS public._verilink_migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      checksum TEXT NOT NULL
    )
  `);

  const entries = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort((a, b) => parseInt(a.split('_')[0], 10) - parseInt(b.split('_')[0], 10));

  const { rows: applied } = await pool.query(
    'SELECT name, checksum FROM public._verilink_migrations'
  );
  const appliedMap = new Map(applied.map((r) => [r.name as string, r.checksum as string]));

  for (const name of entries) {
    const sql = readFileSync(join(MIGRATIONS_DIR, name, 'migration.sql'), 'utf-8');
    const checksum = createHash('sha256').update(sql).digest('hex');
    if (appliedMap.has(name)) {
      if (appliedMap.get(name) !== checksum) {
        throw new Error(`Migration ${name} checksum mismatch`);
      }
      continue;
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query(
        'INSERT INTO public._verilink_migrations (name, checksum) VALUES ($1, $2)',
        [name, checksum]
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  return pool;
}

/** Truncate tenant-scoped / attestation tables between tests. */
export async function resetTestData(pool: pg.Pool): Promise<void> {
  const url = pool.options?.connectionString;
  if (typeof url !== 'string' || url.length === 0) {
    assert.fail(
      'Refusing to reset test data: pool.options.connectionString is missing.'
    );
  }
  assertSafeVerilinkTestDb(url);
  await pool.query(`
    TRUNCATE
      stripe_webhook_events,
      subscriptions,
      decision_batches,
      decision_samples,
      decision_aggregates,
      sync_cursors,
      edge_nodes,
      policies,
      sync_events,
      network_score_history,
      network_scores,
      bootstrap_issuers,
      attestations,
      principal_keys,
      issuers,
      principals,
      api_keys,
      tenant_memberships,
      users,
      tenants
    CASCADE
  `);
}

export async function teardownTestDb(pool: pg.Pool): Promise<void> {
  try {
    await resetTestData(pool);
  } finally {
    await pool.end();
  }
}
