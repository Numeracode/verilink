/**
 * Plan 6 PR B — live RunVeriRank score recompute (mandatory in CI).
 *
 * Requires TRUST_ENGINE_ADDR. Locally you may leave it unset to skip;
 * CI / GITHUB_ACTIONS must set it (workflow starts trust-engine).
 */
process.env.DATABASE_URL ||=
  'postgresql://verilink:verilink@127.0.0.1:15432/verilink_test';
process.env.API_KEY_HMAC_SECRET ||= 'test-hmac-secret-for-integration';

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type pg from 'pg';
import { setupTestDb, teardownTestDb, resetTestData } from '../../testutil/testDb.js';
import {
  seedTenant,
  seedIssuer,
  seedSubject,
  seedBootstrapIssuer,
  seedApiKey,
  authHeaders,
  signAttestationToken,
} from '../../testutil/seedData.js';
import { startControlPlane, type ControlPlaneHarness } from '../../testutil/appHarness.js';
import { recomputeNow } from '../../domains/graph/scoreComputationService.js';
import {
  RecomputeScheduler,
  setRecomputeSchedulerForTests,
} from '../../domains/graph/recomputeScheduler.js';

const trustEngineAddr = process.env.TRUST_ENGINE_ADDR;
const inCi = process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true';
const skipLive = !trustEngineAddr && !inCi;

if (!trustEngineAddr && inCi) {
  throw new Error(
    'TRUST_ENGINE_ADDR is required for score-recompute integration in CI (start cmd/trust-engine)'
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe('Score recompute (live RunVeriRank)', { skip: skipLive }, () => {
  let pool: pg.Pool;
  let harness: ControlPlaneHarness;
  let tenantId: string;
  let apiKey: string;

  before(async () => {
    pool = await setupTestDb();
    harness = await startControlPlane();
  });

  after(async () => {
    setRecomputeSchedulerForTests(null);
    await harness.stop();
    await teardownTestDb(pool);
  });

  beforeEach(async () => {
    setRecomputeSchedulerForTests(null);
    await resetTestData(pool);
    const tenant = await seedTenant(pool, `tenant-score-${Date.now()}`);
    tenantId = tenant.id;
    apiKey = await seedApiKey(pool, tenantId, ['attest:write', 'attest:read']);
  });

  async function seedGraph() {
    const issuer = await seedIssuer(pool, tenantId);
    await seedBootstrapIssuer(pool, issuer.id);
    const subject = await seedSubject(pool, tenantId);
    return { issuer, subject };
  }

  async function submitAttestation(opts: {
    issuer: Awaited<ReturnType<typeof seedIssuer>>;
    subjectId: string;
  }): Promise<{ id: string }> {
    const token = await signAttestationToken({
      issuerId: opts.issuer.id,
      subjectId: opts.subjectId,
      privateKey: opts.issuer.privateKey,
      keyId: opts.issuer.keyId,
    });
    const resp = await fetch(`${harness.url}/v1/attestations/submit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders(apiKey),
      },
      body: JSON.stringify({ token }),
    });
    const bodyText = await resp.text();
    assert.equal(resp.status, 201, bodyText);
    const body = JSON.parse(bodyText) as { ok: boolean; data: { id: string } };
    return body.data;
  }

  it('seeds bootstrap + attestation → scores + score.upsert', async () => {
    const { issuer, subject } = await seedGraph();
    await submitAttestation({ issuer, subjectId: subject.id });

    const result = await recomputeNow(new Date(), { trustEngineAddr });
    assert.equal(result.status, 'applied');
    assert.ok(result.upserts >= 1);

    const { rows: scores } = await pool.query(
      'SELECT principal_id, score FROM network_scores ORDER BY principal_id'
    );
    assert.ok(scores.length >= 1);

    const { rows: events } = await pool.query(
      `SELECT event_type FROM sync_events WHERE event_type = 'score.upsert'`
    );
    assert.ok(events.length >= 1);
  });

  it('excludes expired attestations from scoring', async () => {
    const { issuer, subject } = await seedGraph();
    const submitted = await submitAttestation({ issuer, subjectId: subject.id });
    await pool.query(
      `UPDATE attestations SET expires_at = NOW() - INTERVAL '1 hour' WHERE id = $1`,
      [submitted.id]
    );

    await recomputeNow(new Date(), { trustEngineAddr });
    const { rows } = await pool.query(
      'SELECT principal_id FROM network_scores WHERE principal_id = $1',
      [subject.id]
    );
    assert.equal(rows.length, 0, 'expired attestation must not score the subject');
  });

  it('deactivated principal does not regain a score', async () => {
    const { issuer, subject } = await seedGraph();
    await submitAttestation({ issuer, subjectId: subject.id });
    let result = await recomputeNow(new Date(), { trustEngineAddr });
    assert.equal(result.status, 'applied');

    await pool.query(`UPDATE principals SET status = 'deactivated' WHERE id = $1`, [
      subject.id,
    ]);
    result = await recomputeNow(new Date(), { trustEngineAddr });
    assert.equal(result.status, 'applied');

    const { rows } = await pool.query(
      'SELECT principal_id FROM network_scores WHERE principal_id = $1',
      [subject.id]
    );
    assert.equal(rows.length, 0);
  });

  it('removing last bootstrap root clears existing scores + score.delete', async () => {
    const { issuer, subject } = await seedGraph();
    await submitAttestation({ issuer, subjectId: subject.id });
    const first = await recomputeNow(new Date(), { trustEngineAddr });
    assert.equal(first.status, 'applied');
    assert.ok(first.upserts >= 1);

    await pool.query('DELETE FROM bootstrap_issuers');
    const cleared = await recomputeNow(new Date(), { trustEngineAddr });
    assert.equal(cleared.status, 'cleared_stale');
    assert.ok(cleared.deletes >= 1);

    const { rows: scores } = await pool.query('SELECT principal_id FROM network_scores');
    assert.equal(scores.length, 0);

    const { rows: deletes } = await pool.query(
      `SELECT event_type FROM sync_events WHERE event_type = 'score.delete'`
    );
    assert.ok(deletes.length >= 1);
  });

  it('second submit converges via dirty latch (single-flight)', async () => {
    const { issuer, subject } = await seedGraph();
    const subject2 = await seedSubject(pool, tenantId);
    const calls: number[] = [];

    let resolveGate!: () => void;
    const gate = new Promise<void>((r) => {
      resolveGate = r;
    });
    let passedGate = false;

    const scheduler = new RecomputeScheduler({
      debounceMs: 15,
      intervalMs: 60_000,
      recompute: async (t) => {
        if (!passedGate) {
          await gate;
          passedGate = true;
        }
        calls.push(Date.now());
        return recomputeNow(t, { trustEngineAddr });
      },
    });
    scheduler.start();
    setRecomputeSchedulerForTests(scheduler);

    const runP = scheduler.kick();
    await delay(10);
    await submitAttestation({ issuer, subjectId: subject.id });
    await submitAttestation({ issuer, subjectId: subject2.id });
    scheduler.markDirty();
    resolveGate();
    await runP;
    await delay(80);
    await scheduler.stop();
    setRecomputeSchedulerForTests(null);

    assert.ok(
      calls.length >= 2 && calls.length <= 3,
      `expected 2–3 coalesced runs, got ${calls.length}`
    );

    const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM network_scores');
    assert.ok((rows[0].n as number) >= 1);
  });
});
