// control-plane/src/__tests__/integration/bootstrap-seed.test.ts
process.env.DATABASE_URL ||=
  'postgresql://verilink:verilink@127.0.0.1:15432/verilink_test';
process.env.API_KEY_HMAC_SECRET ||= 'test-hmac-secret-for-integration';

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type pg from 'pg';
import { setupTestDb, teardownTestDb, resetTestData } from '../../testutil/testDb.js';
import {
  seedTenant,
  seedApiKey,
  authHeaders,
} from '../../testutil/seedData.js';
import { startControlPlane, type ControlPlaneHarness } from '../../testutil/appHarness.js';
import { SEED_ISSUERS } from '../../domains/bootstrap/seedManifest.js';

/**
 * Plan 10 PR A: idempotent bootstrap seed, is_bootstrap derivation, PATCH
 * removal survival across reruns, root-weight write-through to the graph
 * loader, and manifest-conflict abort. All seeded rows use the app pool
 * (dynamic imports after env setup).
 */
describe('Bootstrap Seed Integration', () => {
  let pool: pg.Pool;
  let harness: ControlPlaneHarness;

  // Dynamic imports so db/client.ts evaluates after DATABASE_URL is set.
  let seedBootstrapRegistry: () => Promise<{ issuers: number; roots: number }>;
  let loadAttestationGraph: (evaluationTime: Date) => Promise<{
    roots: Array<{ id: string; weight: number }>;
  }>;

  before(async () => {
    pool = await setupTestDb();
    harness = await startControlPlane();
    ({ seedBootstrapRegistry } = await import('../../domains/bootstrap/bootstrapSeeder.js'));
    ({ loadAttestationGraph } = await import('../../domains/graph/attestationGraphLoader.js'));
  });

  after(async () => {
    await harness.stop();
    await teardownTestDb(pool);
  });

  beforeEach(async () => {
    await resetTestData(pool);
  });

  async function seededState() {
    const { rows } = await pool.query(
      `SELECT
         (SELECT count(*)::int FROM issuers WHERE is_bootstrap) AS bs_issuers,
         (SELECT count(*)::int FROM bootstrap_issuers) AS bs_rows,
         (SELECT count(*)::int FROM principals) AS principals,
         (SELECT count(*)::int FROM principal_keys) AS keys`
    );
    return rows[0];
  }

  it('seed is idempotent with exact manifest identities', async () => {
    const first = await seedBootstrapRegistry();
    assert.equal(first.issuers, SEED_ISSUERS.length);
    assert.equal(first.roots, SEED_ISSUERS.length);

    const { rows: seeded } = await pool.query(
      `SELECT p.id, p.entity_kind, p.name, i.trust_weight::float AS trust_weight,
              i.is_bootstrap, k.key_id, b.current_weight::float AS current_weight
       FROM principals p
       JOIN issuers i ON i.principal_id = p.id
       JOIN principal_keys k ON k.principal_id = p.id
       JOIN bootstrap_issuers b ON b.principal_id = p.id
       ORDER BY p.id`
    );
    assert.equal(seeded.length, SEED_ISSUERS.length);
    for (const entry of SEED_ISSUERS) {
      const row = seeded.find((r) => r.id === entry.id);
      assert.ok(row, `seeded principal ${entry.id} present`);
      assert.equal(row.entity_kind, entry.entityKind);
      assert.equal(row.name, entry.name);
      assert.equal(row.trust_weight, 1.0, 'trust_weight untouched by seed');
      assert.equal(row.is_bootstrap, true);
      assert.equal(row.key_id, entry.keyId);
      assert.equal(row.current_weight, 1.0);
    }

    const afterFirst = await seededState();
    assert.equal(afterFirst.bs_issuers, SEED_ISSUERS.length);
    assert.equal(afterFirst.keys, SEED_ISSUERS.length);

    const second = await seedBootstrapRegistry();
    assert.equal(second.issuers, SEED_ISSUERS.length);
    assert.equal(second.roots, SEED_ISSUERS.length);
    const afterSecond = await seededState();
    assert.deepEqual(afterSecond, afterFirst, 'rerun is a no-op');
  });

  it('PATCH removal clears is_bootstrap and seed rerun does not reinstate', async () => {
    await seedBootstrapRegistry();
    const target = SEED_ISSUERS[0];

    const tenantA = await seedTenant(pool, `bs-rm-${Date.now()}`);
    const staffKey = await seedApiKey(pool, tenantA.id, ['admin:read']);

    const res = await fetch(`${harness.url}/v1/admin/bootstrap-issuers`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...authHeaders(staffKey) },
      body: JSON.stringify({ principal_id: target.id, remove_from_registry: true }),
    });
    assert.equal(res.status, 200, JSON.stringify(await res.json()));

    const { rows: afterRemove } = await pool.query(
      `SELECT i.is_bootstrap, b.removed_from_registry_at IS NOT NULL AS removed
       FROM issuers i JOIN bootstrap_issuers b ON b.principal_id = i.principal_id
       WHERE i.principal_id = $1`,
      [target.id]
    );
    assert.equal(afterRemove[0].is_bootstrap, false, 'removal clears is_bootstrap');
    assert.equal(afterRemove[0].removed, true);

    await seedBootstrapRegistry();

    const { rows: afterRerun } = await pool.query(
      `SELECT i.is_bootstrap, b.removed_from_registry_at IS NOT NULL AS removed
       FROM issuers i JOIN bootstrap_issuers b ON b.principal_id = i.principal_id
       WHERE i.principal_id = $1`,
      [target.id]
    );
    assert.equal(afterRerun[0].is_bootstrap, false, 'seed rerun does not reinstate removed issuer');
    assert.equal(afterRerun[0].removed, true, 'removal state preserved across rerun');
  });

  it('PATCH current_weight write-through: GraphRoot.weight changes, trust_weight stays 1.0', async () => {
    await seedBootstrapRegistry();
    const target = SEED_ISSUERS[0];

    const tenantA = await seedTenant(pool, `bs-wt-${Date.now()}`);
    const staffKey = await seedApiKey(pool, tenantA.id, ['admin:read']);

    const res = await fetch(`${harness.url}/v1/admin/bootstrap-issuers`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...authHeaders(staffKey) },
      body: JSON.stringify({ principal_id: target.id, current_weight: 0.5 }),
    });
    assert.equal(res.status, 200, JSON.stringify(await res.json()));

    const { rows: issuerRows } = await pool.query(
      `SELECT trust_weight::float AS trust_weight FROM issuers WHERE principal_id = $1`,
      [target.id]
    );
    assert.equal(issuerRows[0].trust_weight, 1.0, 'trust_weight untouched by de-emphasis');

    const graph = await loadAttestationGraph(new Date());
    const root = graph.roots.find((r) => r.id === target.id);
    assert.ok(root, 'seeded issuer is a graph root');
    assert.equal(root.weight, 0.5, 'GraphRoot.weight reflects PATCHed current_weight');

    const { rows: bsRows } = await pool.query(
      `SELECT is_bootstrap FROM issuers WHERE principal_id = $1`,
      [target.id]
    );
    assert.equal(bsRows[0].is_bootstrap, true, 'positive weight keeps is_bootstrap true');
  });

  it('zero weight or removal drops the issuer from the graph roots', async () => {
    await seedBootstrapRegistry();
    const target = SEED_ISSUERS[0];

    const tenantA = await seedTenant(pool, `bs-z-${Date.now()}`);
    const staffKey = await seedApiKey(pool, tenantA.id, ['admin:read']);

    await fetch(`${harness.url}/v1/admin/bootstrap-issuers`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...authHeaders(staffKey) },
      body: JSON.stringify({ principal_id: target.id, current_weight: 0 }),
    });

    const graph = await loadAttestationGraph(new Date());
    assert.ok(
      !graph.roots.some((r) => r.id === target.id),
      'zero-weight root excluded from graph'
    );
  });

  it('seed aborts when a conflicting bootstrap-k1 key exists; no registry root created', async () => {
    const target = SEED_ISSUERS[0];

    // Preload the manifest principal + issuer with a DIFFERENT key under the
    // manifest key id (simulates a key rotation that diverged from the manifest).
    await pool.query(
      `INSERT INTO principals (id, entity_kind, name) VALUES ($1, $2, $3)`,
      [target.id, target.entityKind, target.name]
    );
    await pool.query(`INSERT INTO issuers (principal_id) VALUES ($1)`, [target.id]);
    const otherRaw = Buffer.from('a'.repeat(32), 'utf8');
    await pool.query(
      `INSERT INTO principal_keys
         (principal_id, key_id, public_key_raw, public_key_jwk, key_hash, control_verified_at)
       VALUES ($1, $2, $3, $4, $5, NOW() - INTERVAL '1 hour')`,
      [
        target.id,
        target.keyId,
        otherRaw,
        JSON.stringify({ kty: 'OKP', crv: 'Ed25519', x: 'a'.repeat(43) }),
        'deadbeef',
      ]
    );

    await assert.rejects(
      () => seedBootstrapRegistry(),
      /bootstrap seed conflict: key .* different public key/
    );

    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM bootstrap_issuers WHERE principal_id = $1`,
      [target.id]
    );
    assert.equal(rows[0].n, 0, 'no registry root created for conflicting key');
  });

  it('seed is gated by BOOTSTRAP_SEED and refuses to run without it', async () => {
    const { execFileSync } = await import('node:child_process');
    assert.throws(() => {
      execFileSync('npx', ['tsx', 'src/scripts/seed-bootstrap.ts'], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          DATABASE_URL: 'postgresql://verilink:verilink@127.0.0.1:15432/verilink_test',
          BOOTSTRAP_SEED: '0',
        },
        encoding: 'utf-8',
      });
    }, /Refusing to seed without BOOTSTRAP_SEED=1/);
  });
});
