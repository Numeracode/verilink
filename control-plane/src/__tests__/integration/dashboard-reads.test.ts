process.env.DATABASE_URL ||=
  'postgresql://verilink:verilink@127.0.0.1:15432/verilink_test';
process.env.API_KEY_HMAC_SECRET ||= 'test-hmac-secret-for-integration';

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type pg from 'pg';
import { setupTestDb, teardownTestDb, resetTestData } from '../../testutil/testDb.js';
import {
  seedTenant,
  seedSubject,
  seedIssuer,
  seedApiKey,
  authHeaders,
} from '../../testutil/seedData.js';
import { startControlPlane, type ControlPlaneHarness } from '../../testutil/appHarness.js';

/** Plan 9 PR B: provider read APIs (aggregates/samples/agents/scores/graph/edge-nodes/policy). */
describe('Dashboard Reads Integration', () => {
  let pool: pg.Pool;
  let harness: ControlPlaneHarness;

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
  });

  async function seedEdge(tenantId: string, name: string): Promise<string> {
    const { rows } = await pool.query(
      `INSERT INTO edge_nodes (tenant_id, name, status) VALUES ($1, $2, 'online') RETURNING id`,
      [tenantId, name]
    );
    return rows[0].id as string;
  }

  async function seedAggregate(
    tenantId: string,
    edgeNodeId: string,
    bucketExpr: string,
    action: string,
    count: number
  ): Promise<void> {
    await pool.query(
      `INSERT INTO decision_aggregates
         (tenant_id, edge_node_id, bucket_minute, dimension_kind, dimension_value, action, count)
       VALUES ($1, $2, ${bucketExpr}, 'all', '', $3, $4)`,
      [tenantId, edgeNodeId, action, count]
    );
  }

  it('GET /v1/policies/active returns the tenant active policy; 404 without one; 401 unauthenticated', async () => {
    const tenantA = await seedTenant(pool, `reads-a-${Date.now()}`);
    const tenantB = await seedTenant(pool, `reads-b-${Date.now()}`);
    const keyA = await seedApiKey(pool, tenantA.id, []);
    const keyB = await seedApiKey(pool, tenantB.id, []);

    await pool.query(
      `INSERT INTO policies (tenant_id, name, threshold) VALUES ($1, 'default', 42)`,
      [tenantA.id]
    );

    const res = await fetch(`${harness.url}/v1/policies/active`, {
      headers: authHeaders(keyA),
    });
    const body = (await res.json()) as { ok: boolean; data: { policy: { threshold: number; name: string } } };
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.equal(body.data.policy.name, 'default');
    assert.equal(body.data.policy.threshold, 42);

    const none = await fetch(`${harness.url}/v1/policies/active`, {
      headers: authHeaders(keyB),
    });
    assert.equal(none.status, 404);

    const unauth = await fetch(`${harness.url}/v1/policies/active`);
    assert.equal(unauth.status, 401);
  });

  it('GET /v1/decisions/aggregates: tenant isolation, default 24h window, cross-edge sum, 31d cap', async () => {
    const tenantA = await seedTenant(pool, `agg-a-${Date.now()}`);
    const tenantB = await seedTenant(pool, `agg-b-${Date.now()}`);
    const keyA = await seedApiKey(pool, tenantA.id, []);
    const keyB = await seedApiKey(pool, tenantB.id, []);
    const edgeA1 = await seedEdge(tenantA.id, 'edge-a1');
    const edgeA2 = await seedEdge(tenantA.id, 'edge-a2');
    const edgeB = await seedEdge(tenantB.id, 'edge-b');

    const recent = `date_trunc('minute', now()) - interval '1 minute'`;
    const stale = `date_trunc('minute', now()) - interval '2 days'`;
    await seedAggregate(tenantA.id, edgeA1, recent, 'allow', 7);
    await seedAggregate(tenantA.id, edgeA2, recent, 'allow', 3); // same bucket → summed
    await seedAggregate(tenantA.id, edgeA1, recent, 'deny', 2);
    await seedAggregate(tenantA.id, edgeA1, stale, 'allow', 99); // outside default window
    await seedAggregate(tenantB.id, edgeB, recent, 'allow', 5);

    const res = await fetch(`${harness.url}/v1/decisions/aggregates`, {
      headers: authHeaders(keyA),
    });
    const body = (await res.json()) as {
      ok: boolean;
      data: { dimension: string; items: Array<{ action: string; count: number }> };
    };
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.equal(body.data.dimension, 'all');
    const allow = body.data.items.find((i) => i.action === 'allow');
    const deny = body.data.items.find((i) => i.action === 'deny');
    assert.equal(allow?.count, 10, 'allow counts summed across edges');
    assert.equal(deny?.count, 2);
    assert.equal(body.data.items.length, 2, 'stale bucket excluded by default window');

    // Explicit window includes the stale bucket
    const from = new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString();
    const wide = await fetch(
      `${harness.url}/v1/decisions/aggregates?from=${encodeURIComponent(from)}`,
      { headers: authHeaders(keyA) }
    );
    const wideBody = (await wide.json()) as { data: { items: Array<{ action: string; count: number }> } };
    const wideAllow = wideBody.data.items
      .filter((i) => i.action === 'allow')
      .reduce((n, i) => n + i.count, 0);
    assert.equal(wideAllow, 109);

    // Tenant isolation
    const resB = await fetch(`${harness.url}/v1/decisions/aggregates`, {
      headers: authHeaders(keyB),
    });
    const bodyB = (await resB.json()) as { data: { items: Array<{ count: number }> } };
    assert.equal(bodyB.data.items.reduce((n, i) => n + i.count, 0), 5);

    // 31d cap
    const tooWide = await fetch(
      `${harness.url}/v1/decisions/aggregates?from=${encodeURIComponent('2026-01-01T00:00:00Z')}`,
      { headers: authHeaders(keyA) }
    );
    assert.equal(tooWide.status, 400);
  });

  it('GET /v1/decisions/samples: newest-first, limit, tenant isolation', async () => {
    const tenantA = await seedTenant(pool, `smp-a-${Date.now()}`);
    const tenantB = await seedTenant(pool, `smp-b-${Date.now()}`);
    const keyA = await seedApiKey(pool, tenantA.id, []);
    const keyB = await seedApiKey(pool, tenantB.id, []);
    const edgeA = await seedEdge(tenantA.id, 'edge-a');
    const edgeB = await seedEdge(tenantB.id, 'edge-b');
    const subject = await seedSubject(pool, tenantA.id);

    const insertSample = (
      tenantId: string,
      edgeId: string,
      walSeq: number,
      principalId: string | null,
      action: string,
      decidedExpr: string
    ) =>
      pool.query(
        `INSERT INTO decision_samples
           (tenant_id, edge_node_id, wal_seq, fingerprint, principal_id, score, blacklisted, score_reason, action, decided_at)
         VALUES ($1, $2, $3, 'fp-x', $4, 55, false, 'propagated', $5, ${decidedExpr})`,
        [tenantId, edgeId, walSeq, principalId, action]
      );

    await insertSample(tenantA.id, edgeA, 1, subject.id, 'deny', `now() - interval '10 minutes'`);
    await insertSample(tenantA.id, edgeA, 2, subject.id, 'allow', `now() - interval '1 minute'`);
    await insertSample(tenantB.id, edgeB, 1, null, 'allow', `now()`);

    const res = await fetch(`${harness.url}/v1/decisions/samples?limit=50`, {
      headers: authHeaders(keyA),
    });
    const body = (await res.json()) as {
      data: { items: Array<{ action: string; principal_id: string | null }> };
    };
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.equal(body.data.items.length, 2, 'only tenant A samples');
    assert.equal(body.data.items[0].action, 'allow', 'newest first');
    assert.equal(body.data.items[1].action, 'deny');

    const limited = await fetch(`${harness.url}/v1/decisions/samples?limit=1`, {
      headers: authHeaders(keyA),
    });
    const limitedBody = (await limited.json()) as { data: { items: unknown[] } };
    assert.equal(limitedBody.data.items.length, 1);

    const resB = await fetch(`${harness.url}/v1/decisions/samples`, {
      headers: authHeaders(keyB),
    });
    const bodyB = (await resB.json()) as { data: { items: unknown[] } };
    assert.equal(bodyB.data.items.length, 1);
  });

  it('GET /v1/decisions/agents: distinct principals with current score + blacklisted flag', async () => {
    const tenantA = await seedTenant(pool, `agt-a-${Date.now()}`);
    const tenantB = await seedTenant(pool, `agt-b-${Date.now()}`);
    const keyA = await seedApiKey(pool, tenantA.id, []);
    const keyB = await seedApiKey(pool, tenantB.id, []);
    const edgeA = await seedEdge(tenantA.id, 'edge-a');
    const agent = await seedSubject(pool, tenantA.id);

    await pool.query(
      `INSERT INTO network_scores (principal_id, entity_kind, score, blacklisted, score_reason, sync_version)
       VALUES ($1, 'agent', 12, true, 'blacklisted', 7)`,
      [agent.id]
    );
    await pool.query(
      `INSERT INTO decision_samples
         (tenant_id, edge_node_id, wal_seq, fingerprint, principal_id, score, blacklisted, score_reason, action, decided_at)
       VALUES ($1, $2, 1, 'fp-a', $3, 12, true, 'blacklisted', 'deny', now())`,
      [tenantA.id, edgeA, agent.id]
    );
    await pool.query(
      `INSERT INTO decision_samples
         (tenant_id, edge_node_id, wal_seq, fingerprint, principal_id, score, blacklisted, score_reason, action, decided_at)
       VALUES ($1, $2, 2, 'fp-b', $3, 12, true, 'blacklisted', 'deny', now())`,
      [tenantA.id, edgeA, agent.id]
    );

    const res = await fetch(`${harness.url}/v1/decisions/agents`, {
      headers: authHeaders(keyA),
    });
    const body = (await res.json()) as {
      data: {
        items: Array<{
          principal_id: string;
          decisions: number;
          score: number | null;
          blacklisted: boolean | null;
          score_reason: string | null;
        }>;
      };
    };
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.equal(body.data.items.length, 1, 'distinct per principal');
    const row = body.data.items[0];
    assert.equal(row.principal_id, agent.id);
    assert.equal(row.decisions, 2);
    assert.equal(row.score, 12);
    assert.equal(row.blacklisted, true, 'blacklisted surfaced from network_scores');
    assert.equal(row.score_reason, 'blacklisted');

    const resB = await fetch(`${harness.url}/v1/decisions/agents`, {
      headers: authHeaders(keyB),
    });
    const bodyB = (await resB.json()) as { data: { items: unknown[] } };
    assert.equal(bodyB.data.items.length, 0);
  });

  it('GET /v1/scores/:principalId/history: current + newest-first history; empty for unknown', async () => {
    const tenantA = await seedTenant(pool, `scr-a-${Date.now()}`);
    const keyA = await seedApiKey(pool, tenantA.id, []);
    const subject = await seedSubject(pool, tenantA.id);

    await pool.query(
      `INSERT INTO network_scores (principal_id, entity_kind, score, blacklisted, score_reason, sync_version)
       VALUES ($1, 'agent', 80, false, 'propagated', 3)`,
      [subject.id]
    );
    await pool.query(
      `INSERT INTO network_score_history (principal_id, entity_kind, score, blacklisted, score_reason, computed_at, sync_version)
       VALUES ($1, 'agent', 70, false, 'propagated', now() - interval '2 hours', 2),
              ($1, 'agent', 80, false, 'propagated', now() - interval '1 hours', 3)`,
      [subject.id]
    );

    const res = await fetch(`${harness.url}/v1/scores/${encodeURIComponent(subject.id)}/history`, {
      headers: authHeaders(keyA),
    });
    const body = (await res.json()) as {
      data: {
        current: { score: number } | null;
        items: Array<{ score: number; sync_version: string }>;
      };
    };
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.equal(body.data.current?.score, 80);
    assert.equal(body.data.items.length, 2);
    assert.equal(body.data.items[0].sync_version, '3', 'newest first');
    assert.equal(body.data.items[1].score, 70);

    const unknown = await fetch(
      `${harness.url}/v1/scores/${encodeURIComponent('vrl:p:00000000-0000-0000-0000-000000000000')}/history`,
      { headers: authHeaders(keyA) }
    );
    assert.equal(unknown.status, 200);
    const unknownBody = (await unknown.json()) as {
      data: { current: unknown; items: unknown[] };
    };
    assert.equal(unknownBody.data.current, null);
    assert.equal(unknownBody.data.items.length, 0);
  });

  it('GET /v1/graph/summary: counts, top issuers, latest score time; 401 unauthenticated', async () => {
    const tenantA = await seedTenant(pool, `grf-a-${Date.now()}`);
    const keyA = await seedApiKey(pool, tenantA.id, []);
    const issuer = await seedIssuer(pool, tenantA.id);
    const subject = await seedSubject(pool, tenantA.id);

    await pool.query(
      `INSERT INTO network_scores (principal_id, entity_kind, score, blacklisted, score_reason, computed_at, sync_version)
       VALUES ($1, 'agent', 90, false, 'propagated', now(), 1)`,
      [subject.id]
    );

    const res = await fetch(`${harness.url}/v1/graph/summary`, {
      headers: authHeaders(keyA),
    });
    const body = (await res.json()) as {
      data: {
        principals: { total: number; agents: number; issuers: number };
        attestations: { total: number };
        top_issuers: Array<{ issuer_id: string; outgoing: number }>;
        latest_score_computed_at: string | null;
      };
    };
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.equal(body.data.principals.total, 2);
    assert.equal(body.data.principals.agents, 1);
    assert.equal(body.data.principals.issuers, 1);
    assert.equal(body.data.attestations.total, 0);
    assert.ok(Array.isArray(body.data.top_issuers));
    assert.ok(body.data.latest_score_computed_at, 'latest score time present');

    const unauth = await fetch(`${harness.url}/v1/graph/summary`);
    assert.equal(unauth.status, 401);
  });

  it('GET /v1/edge-nodes: tenant fleet with lag; isolated per tenant', async () => {
    const tenantA = await seedTenant(pool, `edg-a-${Date.now()}`);
    const tenantB = await seedTenant(pool, `edg-b-${Date.now()}`);
    const keyA = await seedApiKey(pool, tenantA.id, []);
    const keyB = await seedApiKey(pool, tenantB.id, []);
    const edgeA = await seedEdge(tenantA.id, 'edge-a');

    await pool.query(
      `INSERT INTO sync_cursors (tenant_id, edge_node_id, last_cursor, last_sync_at)
       VALUES ($1, $2, 5, now())`,
      [tenantA.id, edgeA]
    );
    await pool.query(
      `INSERT INTO sync_events (sync_version, event_type, tenant_id, payload)
       VALUES (10, 'policy.replace', $1, '{}')`,
      [tenantA.id]
    );

    const res = await fetch(`${harness.url}/v1/edge-nodes`, {
      headers: authHeaders(keyA),
    });
    const body = (await res.json()) as {
      data: {
        items: Array<{
          id: string;
          name: string;
          last_cursor: string;
          high_water_version: string;
          lag: string;
        }>;
      };
    };
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.equal(body.data.items.length, 1);
    const edge = body.data.items[0];
    assert.equal(edge.name, 'edge-a');
    assert.equal(edge.last_cursor, '5');
    assert.equal(edge.high_water_version, '10');
    assert.equal(edge.lag, '5');

    const resB = await fetch(`${harness.url}/v1/edge-nodes`, {
      headers: authHeaders(keyB),
    });
    const bodyB = (await resB.json()) as { data: { items: unknown[] } };
    assert.equal(bodyB.data.items.length, 0);
  });
});
