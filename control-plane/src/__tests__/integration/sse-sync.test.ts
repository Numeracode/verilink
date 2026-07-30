/**
 * Plan 7 PR B — SSE sync integration (cursor persist, lag, stream basics).
 *
 * Score-event cases require TRUST_ENGINE_ADDR (same as Plan 6 score-recompute).
 * Structural SSE cases (parse, 503, heartbeat, empty bootstrap) always run.
 */
process.env.DATABASE_URL ||=
  'postgresql://verilink:verilink@127.0.0.1:15432/verilink_test';
process.env.API_KEY_HMAC_SECRET ||= 'test-hmac-secret-for-integration';
process.env.SYNC_SSE_POLL_INTERVAL_MS ||= '100';
process.env.SYNC_SSE_HEARTBEAT_INTERVAL_MS ||= '150';
process.env.SYNC_SSE_MAX_CONNECTIONS ||= '3';
process.env.SYNC_SSE_MAX_INITIAL_BATCH ||= '5';
process.env.SYNC_SSE_CURSOR_PERSIST_INTERVAL_MS ||= '200';
process.env.SYNC_SSE_CURSOR_PERSIST_EVERY_EVENTS ||= '2';

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

const trustEngineAddr = process.env.TRUST_ENGINE_ADDR;
const inCi = process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true';
const skipLive = !trustEngineAddr && !inCi;

if (!trustEngineAddr && inCi) {
  throw new Error(
    'TRUST_ENGINE_ADDR is required for sse-sync score cases in CI (start cmd/trust-engine)'
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function readSseUntil(
  url: string,
  headers: Record<string, string>,
  pred: (buf: string) => boolean,
  timeoutMs = 5000
): Promise<{ status: number; body: string; headers: Headers }> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { headers, signal: ac.signal });
    if (!resp.ok || !resp.body) {
      clearTimeout(timer);
      return { status: resp.status, body: await resp.text(), headers: resp.headers };
    }
    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      if (pred(buf)) {
        ac.abort();
        break;
      }
    }
    clearTimeout(timer);
    return { status: resp.status, body: buf, headers: resp.headers };
  } catch (err) {
    clearTimeout(timer);
    if ((err as Error).name === 'AbortError') {
      throw err;
    }
    throw err;
  }
}

describe('SSE sync', () => {
  let pool: pg.Pool;
  let harness: ControlPlaneHarness;
  let tenantId: string;
  let apiKey: string;
  let adminKey: string;

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
    const tenant = await seedTenant(pool, `tenant-sse-${Date.now()}`);
    tenantId = tenant.id;
    apiKey = await seedApiKey(pool, tenantId, ['attest:write', 'attest:read']);
    adminKey = await seedApiKey(pool, tenantId, ['admin:read']);
  });

  it('rejects blank Last-Event-ID with 400', async () => {
    const resp = await fetch(`${harness.url}/v1/sync/events?last_event_id=`, {
      headers: authHeaders(apiKey),
    });
    assert.equal(resp.status, 400);
  });

  it('rejects non-numeric Last-Event-ID with 400', async () => {
    const resp = await fetch(`${harness.url}/v1/sync/events`, {
      headers: { ...authHeaders(apiKey), 'Last-Event-ID': 'abc' },
    });
    assert.equal(resp.status, 400);
  });

  it('empty sync_events: bootstrap cursor id 0 and ping heartbeat', async () => {
    const { status, body } = await readSseUntil(
      `${harness.url}/v1/sync/events`,
      { ...authHeaders(apiKey), Accept: 'text/event-stream' },
      (b) => b.includes('event: cursor') && b.includes(': ping'),
      4000
    );
    assert.equal(status, 200);
    assert.match(body, /retry:\s*\d+/);
    assert.match(body, /event: cursor/);
    assert.match(body, /id: 0/);
    assert.match(body, /: ping/);
    // Let disconnect persist finish before next beforeEach truncates edge_nodes.
    await delay(200);
  });

  it('returns 503 when max connections exceeded', async () => {
    const controllers: AbortController[] = [];
    const open = async () => {
      const ac = new AbortController();
      controllers.push(ac);
      return fetch(`${harness.url}/v1/sync/events`, {
        headers: { ...authHeaders(apiKey), Accept: 'text/event-stream' },
        signal: ac.signal,
      });
    };
    const r1 = await open();
    const r2 = await open();
    const r3 = await open();
    assert.equal(r1.status, 200);
    assert.equal(r2.status, 200);
    assert.equal(r3.status, 200);
    const r4 = await open();
    assert.equal(r4.status, 503);
    for (const c of controllers) c.abort();
    await delay(200);
  });

  it('returns 429 when backlog exceeds max initial batch', async () => {
    for (let i = 0; i < 6; i++) {
      await pool.query(
        `INSERT INTO sync_events (sync_version, event_type, principal_id, tenant_id, payload)
         SELECT COALESCE(MAX(sync_version), 0) + 1, 'score.upsert', NULL, NULL, '{}'::jsonb
         FROM sync_events`
      );
    }
    const resp = await fetch(`${harness.url}/v1/sync/events?last_event_id=0`, {
      headers: authHeaders(apiKey),
    });
    assert.equal(resp.status, 429);
    assert.equal(resp.headers.get('x-verilink-sync-reason'), 'backlog-cap');
  });

  it('persists sync_cursors on disconnect and reports lag', async () => {
    await pool.query(
      `INSERT INTO sync_events (sync_version, event_type, principal_id, tenant_id, payload)
       SELECT COALESCE(MAX(sync_version), 0) + 1, 'key.upsert', NULL, NULL, '{}'::jsonb
       FROM sync_events`
    );
    const ac = new AbortController();
    const resp = await fetch(`${harness.url}/v1/sync/events`, {
      headers: { ...authHeaders(apiKey), Accept: 'text/event-stream' },
      signal: ac.signal,
    });
    assert.equal(resp.status, 200);
    const reader = resp.body!.getReader();
    const dec = new TextDecoder();
    let buf = '';
    while (!buf.includes('event: cursor')) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
    }
    ac.abort();
    await delay(300);

    const { rows } = await pool.query(
      `SELECT last_cursor FROM sync_cursors WHERE tenant_id = $1`,
      [tenantId]
    );
    assert.ok(rows.length >= 1, 'expected sync_cursors row');
    assert.ok(Number(rows[0].last_cursor) >= 0);

    const lagResp = await fetch(`${harness.url}/v1/admin/sync/lag`, {
      headers: authHeaders(adminKey),
    });
    assert.equal(lagResp.status, 200);
    const lagBody = (await lagResp.json()) as {
      ok: boolean;
      data: { edges: Array<{ lag: string }> };
    };
    assert.equal(lagBody.ok, true);
    assert.ok(lagBody.data.edges.length >= 1);
  });

  it('forbids lag endpoint without admin:read', async () => {
    const resp = await fetch(`${harness.url}/v1/admin/sync/lag`, {
      headers: authHeaders(apiKey),
    });
    assert.equal(resp.status, 403);
  });
});

describe('SSE sync score events (live trust-engine)', { skip: skipLive }, () => {
  let pool: pg.Pool;
  let harness: ControlPlaneHarness;
  let tenantId: string;
  let apiKey: string;
  let recomputeNow: typeof import('../../domains/graph/scoreComputationService.js').recomputeNow;

  before(async () => {
    const scoreMod = await import('../../domains/graph/scoreComputationService.js');
    recomputeNow = scoreMod.recomputeNow;
    pool = await setupTestDb();
    harness = await startControlPlane();
  });

  after(async () => {
    await harness.stop();
    await teardownTestDb(pool);
  });

  beforeEach(async () => {
    await resetTestData(pool);
    const tenant = await seedTenant(pool, `tenant-sse-score-${Date.now()}`);
    tenantId = tenant.id;
    apiKey = await seedApiKey(pool, tenantId, ['attest:write', 'attest:read']);
  });

  it('streams score.upsert after recompute', async () => {
    const issuer = await seedIssuer(pool, tenantId);
    await seedBootstrapIssuer(pool, issuer.id);
    const subject = await seedSubject(pool, tenantId);
    const token = await signAttestationToken({
      issuerId: issuer.id,
      subjectId: subject.id,
      privateKey: issuer.privateKey,
      keyId: issuer.keyId,
    });
    const submit = await fetch(`${harness.url}/v1/attestations/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(apiKey) },
      body: JSON.stringify({ token }),
    });
    assert.equal(submit.status, 201, await submit.text());
    await recomputeNow(new Date());

    const { status, body } = await readSseUntil(
      `${harness.url}/v1/sync/events`,
      { ...authHeaders(apiKey), Accept: 'text/event-stream' },
      (b) => b.includes('event: score.upsert'),
      8000
    );
    assert.equal(status, 200);
    assert.match(body, /event: score\.upsert/);
  });
});
