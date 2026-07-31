/**
 * Plan 8 PR C — decision batch ingest integration.
 */
process.env.DATABASE_URL ||=
  'postgresql://verilink:verilink@127.0.0.1:15432/verilink_test';
process.env.API_KEY_HMAC_SECRET ||= 'test-hmac-secret-for-integration';

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type pg from 'pg';
import { setupTestDb, teardownTestDb, resetTestData } from '../../testutil/testDb.js';
import { seedTenant, seedApiKey, authHeaders } from '../../testutil/seedData.js';
import { startControlPlane, type ControlPlaneHarness } from '../../testutil/appHarness.js';
import { shouldSample } from '../../domains/decision/decisionSample.js';

function buildBatch(decisions: Array<Record<string, unknown>>) {
  const payload = JSON.stringify(decisions);
  const sum = createHash('sha256').update(payload).digest('hex');
  const id = `${sum.slice(0, 8)}-${sum.slice(8, 12)}-${sum.slice(12, 16)}-${sum.slice(16, 20)}-${sum.slice(20, 32)}`;
  return {
    batch_id: id,
    first_wal_seq: decisions[0].wal_seq as number,
    last_wal_seq: decisions[decisions.length - 1].wal_seq as number,
    payload_hash: sum,
    decisions,
  };
}

describe('decision batch ingest', () => {
  let pool: pg.Pool;
  let harness: ControlPlaneHarness;
  let apiKey: string;

  before(async () => {
    pool = await setupTestDb();
    harness = await startControlPlane();
  });

  after(async () => {
    await harness.stop();
    await teardownTestDb(pool);
  });

  beforeEach(async () => {
    await resetTestData(pool);
    const tenant = await seedTenant(pool, `decisions-${Date.now()}`);
    apiKey = await seedApiKey(pool, tenant.id, ['*']);
  });

  it('shouldSample keeps all denies and rate-limits allows', () => {
    assert.equal(shouldSample('deny', 1, 0), true);
    assert.equal(shouldSample('allow', 1, 0), false);
    assert.equal(shouldSample('allow', 1, 1), true);
  });

  it('accepts a batch and is idempotent on redelivery', async () => {
    const decidedAt = new Date().toISOString();
    const batch = buildBatch([
      {
        wal_seq: 1,
        fingerprint: 'fp-deny',
        principal_id: 'vrl:p:1',
        score: 10,
        blacklisted: false,
        action: 'deny',
        decided_at: decidedAt,
      },
      {
        wal_seq: 2,
        fingerprint: 'fp-allow',
        action: 'allow',
        score: 90,
        decided_at: decidedAt,
      },
    ]);

    const resp = await fetch(`${harness.url}/v1/decisions/batch`, {
      method: 'POST',
      headers: { ...authHeaders(apiKey), 'Content-Type': 'application/json' },
      body: JSON.stringify(batch),
    });
    assert.equal(resp.status, 200);
    const body = (await resp.json()) as { ok: boolean; data: { duplicate: boolean; accepted: number } };
    assert.equal(body.ok, true);
    assert.equal(body.data.duplicate, false);
    assert.equal(body.data.accepted, 2);

    const again = await fetch(`${harness.url}/v1/decisions/batch`, {
      method: 'POST',
      headers: { ...authHeaders(apiKey), 'Content-Type': 'application/json' },
      body: JSON.stringify(batch),
    });
    assert.equal(again.status, 200);
    const againBody = (await again.json()) as { data: { duplicate: boolean } };
    assert.equal(againBody.data.duplicate, true);

    const samples = await pool.query(`SELECT action FROM decision_samples ORDER BY wal_seq`);
    assert.ok(samples.rows.some((r: { action: string }) => r.action === 'deny'));

    const aggs = await pool.query(
      `SELECT SUM(count)::int AS n FROM decision_aggregates WHERE dimension_kind = 'all'`
    );
    assert.equal(aggs.rows[0].n, 2);
  });

  it('returns 409 when batch_id is reused with a different payload_hash', async () => {
    const decidedAt = new Date().toISOString();
    const batch = buildBatch([
      {
        wal_seq: 1,
        fingerprint: 'fp-a',
        action: 'deny',
        decided_at: decidedAt,
      },
    ]);
    const first = await fetch(`${harness.url}/v1/decisions/batch`, {
      method: 'POST',
      headers: { ...authHeaders(apiKey), 'Content-Type': 'application/json' },
      body: JSON.stringify(batch),
    });
    assert.equal(first.status, 200);

    const conflict = {
      ...batch,
      payload_hash: '0'.repeat(64),
    };
    const resp = await fetch(`${harness.url}/v1/decisions/batch`, {
      method: 'POST',
      headers: { ...authHeaders(apiKey), 'Content-Type': 'application/json' },
      body: JSON.stringify(conflict),
    });
    assert.equal(resp.status, 409);
  });
});
