/**
 * Plan 8 PR C — decision batch ingest integration.
 */
process.env.DATABASE_URL ||=
  'postgresql://verilink:verilink@127.0.0.1:15432/verilink_test';
process.env.API_KEY_HMAC_SECRET ||= 'test-hmac-secret-for-integration';

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type pg from 'pg';
import { setupTestDb, teardownTestDb, resetTestData } from '../../testutil/testDb.js';
import { seedTenant, seedApiKey, authHeaders } from '../../testutil/seedData.js';
import { startControlPlane, type ControlPlaneHarness } from '../../testutil/appHarness.js';
import {
  batchIDFromPayloadHash,
  canonicalizeDecisionsJSON,
  sha256Hex,
  shouldSample,
  type DecisionWire,
} from '../../domains/decision/decisionSample.js';

function buildBatch(decisions: DecisionWire[]) {
  const sum = sha256Hex(canonicalizeDecisionsJSON(decisions));
  return {
    batch_id: batchIDFromPayloadHash(sum),
    first_wal_seq: decisions[0].wal_seq,
    last_wal_seq: decisions[decisions.length - 1].wal_seq,
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
    const t = '2026-07-31T12:00:00.001Z';
    assert.equal(shouldSample('deny', t, 0), true);
    assert.equal(shouldSample('allow', t, 0), false);
    assert.equal(shouldSample('allow', t, 1), true);
  });

  it('rejects payload_hash that does not match decisions', async () => {
    const decidedAt = new Date().toISOString();
    const batch = buildBatch([
      {
        wal_seq: 1,
        fingerprint: 'fp-a',
        action: 'deny',
        decided_at: decidedAt,
      },
    ]);
    const resp = await fetch(`${harness.url}/v1/decisions/batch`, {
      method: 'POST',
      headers: { ...authHeaders(apiKey), 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...batch, payload_hash: '0'.repeat(64) }),
    });
    assert.equal(resp.status, 400);
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

  it('returns 409 when stored batch_id hash conflicts with a redelivery', async () => {
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

    // Simulate a corrupted / poisoned stored hash for the same batch_id.
    await pool.query(`UPDATE decision_batches SET payload_hash = $1 WHERE batch_id = $2`, [
      '1'.repeat(64),
      batch.batch_id,
    ]);

    const resp = await fetch(`${harness.url}/v1/decisions/batch`, {
      method: 'POST',
      headers: { ...authHeaders(apiKey), 'Content-Type': 'application/json' },
      body: JSON.stringify(batch),
    });
    assert.equal(resp.status, 409);
  });

  it('rejects non-RFC3339 decided_at', async () => {
    const resp = await fetch(`${harness.url}/v1/decisions/batch`, {
      method: 'POST',
      headers: { ...authHeaders(apiKey), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        batch_id: '11111111-1111-1111-1111-111111111111',
        first_wal_seq: 1,
        last_wal_seq: 1,
        payload_hash: 'a'.repeat(64),
        decisions: [
          {
            wal_seq: 1,
            fingerprint: 'fp-a',
            action: 'deny',
            decided_at: '2026-07-31 12:00:00',
          },
        ],
      }),
    });
    assert.equal(resp.status, 400);
  });
});
