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

/** Plan 9 PR C: policy PUT (with policy.replace sync), API-key CRUD, agent-builder reads. */
describe('Dashboard Writes Integration', () => {
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

  async function policyEvents(tenantId: string): Promise<number> {
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM sync_events WHERE event_type='policy.replace' AND tenant_id=$1`,
      [tenantId]
    );
    return rows[0].n;
  }

  describe('PUT /v1/policies/active', () => {
    it('creates the active policy, emits policy.replace, and serves it on GET', async () => {
      const tenantA = await seedTenant(pool, `pol-a-${Date.now()}`);
      const adminKey = await seedApiKey(pool, tenantA.id, ['policy:admin']);

      const res = await fetch(`${harness.url}/v1/policies/active`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...authHeaders(adminKey) },
        body: JSON.stringify({ threshold: 80, allow_sample_rate: 0.05 }),
      });
      const body = (await res.json()) as { ok: boolean; data: { policy: { threshold: number; name: string }; sync_version: number } };
      assert.equal(res.status, 200, JSON.stringify(body));
      assert.equal(body.data.policy.threshold, 80);
      assert.equal(body.data.policy.name, 'default');
      assert.ok(body.data.sync_version > 0, 'sync_version allocated');
      assert.equal(await policyEvents(tenantA.id), 1, 'one policy.replace event emitted');

      const getRes = await fetch(`${harness.url}/v1/policies/active`, {
        headers: authHeaders(adminKey),
      });
      const getBody = (await getRes.json()) as { data: { policy: { threshold: number; allow_sample_rate: number } } };
      assert.equal(getBody.data.policy.threshold, 80);
      assert.equal(getBody.data.policy.allow_sample_rate, 0.05);
    });

    it('updates the existing active policy and emits a second event', async () => {
      const tenantA = await seedTenant(pool, `pol-up-${Date.now()}`);
      const adminKey = await seedApiKey(pool, tenantA.id, ['policy:admin']);

      await fetch(`${harness.url}/v1/policies/active`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...authHeaders(adminKey) },
        body: JSON.stringify({ threshold: 60 }),
      });

      const res = await fetch(`${harness.url}/v1/policies/active`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...authHeaders(adminKey) },
        body: JSON.stringify({ threshold: 40, below_threshold_action: 'allow' }),
      });
      const body = (await res.json()) as { data: { policy: { threshold: number; below_threshold_action: string } } };
      assert.equal(res.status, 200, JSON.stringify(body));
      assert.equal(body.data.policy.threshold, 40);
      assert.equal(body.data.policy.below_threshold_action, 'allow');
      assert.equal(await policyEvents(tenantA.id), 2, 'second event emitted');
    });

    it('rejects a key without the policy:admin scope (403) and an invalid body (400)', async () => {
      const tenantA = await seedTenant(pool, `pol-authz-${Date.now()}`);
      const readOnlyKey = await seedApiKey(pool, tenantA.id, ['attest:read']);

      const forbidden = await fetch(`${harness.url}/v1/policies/active`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...authHeaders(readOnlyKey) },
        body: JSON.stringify({ threshold: 50 }),
      });
      assert.equal(forbidden.status, 403);

      const adminKey = await seedApiKey(pool, tenantA.id, ['policy:admin']);
      const bad = await fetch(`${harness.url}/v1/policies/active`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...authHeaders(adminKey) },
        body: JSON.stringify({ threshold: 200 }),
      });
      assert.equal(bad.status, 400);
    });

    it('requires authentication', async () => {
      const res = await fetch(`${harness.url}/v1/policies/active`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ threshold: 50 }),
      });
      assert.equal(res.status, 401);
    });
  });

  describe('API key CRUD', () => {
    it('mints a working key, lists it, and revokes it', async () => {
      const tenantA = await seedTenant(pool, `key-a-${Date.now()}`);
      const adminKey = await seedApiKey(pool, tenantA.id, ['policy:admin']);

      const createRes = await fetch(`${harness.url}/v1/api-keys`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(adminKey) },
        body: JSON.stringify({ scopes: ['attest:read', 'policy:read'] }),
      });
      const createBody = (await createRes.json()) as {
        data: { id: string; secret: string; scopes: string[]; key_prefix: string };
      };
      assert.equal(createRes.status, 201, JSON.stringify(createBody));
      assert.match(createBody.data.secret, /^vrl_[0-9a-f]{64}$/);
      assert.equal(createBody.data.secret.length, 68);
      assert.deepEqual(createBody.data.scopes, ['attest:read', 'policy:read']);
      assert.equal(createBody.data.key_prefix.length, 7);

      // The minted secret authenticates and lists the tenant's keys
      // (the seed adminKey + the minted one).
      const listRes = await fetch(`${harness.url}/v1/api-keys`, {
        headers: authHeaders(createBody.data.secret),
      });
      const listBody = (await listRes.json()) as { data: { items: Array<{ id: string; scopes: string[] }> } };
      assert.equal(listRes.status, 200, JSON.stringify(listBody));
      const minted = listBody.data.items.find((k) => k.id === createBody.data.id);
      assert.ok(minted, 'minted key is listed');
      assert.deepEqual(minted!.scopes, ['attest:read', 'policy:read']);

      const delRes = await fetch(`${harness.url}/v1/api-keys/${createBody.data.id}`, {
        method: 'DELETE',
        headers: authHeaders(adminKey),
      });
      assert.equal(delRes.status, 204);

      const after = await fetch(`${harness.url}/v1/api-keys`, {
        headers: authHeaders(adminKey),
      });
      const afterBody = (await after.json()) as { data: { items: Array<{ id: string }> } };
      assert.equal(afterBody.data.items.length, 1, 'only the seed key remains');
      assert.ok(!afterBody.data.items.some((k) => k.id === createBody.data.id));

      // The revoked secret no longer authenticates.
      const staleRes = await fetch(`${harness.url}/v1/api-keys`, {
        headers: authHeaders(createBody.data.secret),
      });
      assert.equal(staleRes.status, 401);
    });

    it('rejects unknown scopes and non-array scopes', async () => {
      const tenantA = await seedTenant(pool, `key-val-${Date.now()}`);
      const adminKey = await seedApiKey(pool, tenantA.id, ['policy:admin']);

      const unknown = await fetch(`${harness.url}/v1/api-keys`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(adminKey) },
        body: JSON.stringify({ scopes: ['bogus:scope'] }),
      });
      assert.equal(unknown.status, 400);

      const nonArray = await fetch(`${harness.url}/v1/api-keys`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(adminKey) },
        body: JSON.stringify({ scopes: 'attest:read' }),
      });
      assert.equal(nonArray.status, 400);
    });

    it('does not leak cross-tenant keys on delete (404)', async () => {
      const tenantA = await seedTenant(pool, `key-iso-a-${Date.now()}`);
      const tenantB = await seedTenant(pool, `key-iso-b-${Date.now()}`);
      const keyA = await seedApiKey(pool, tenantA.id, ['policy:admin']);
      const keyB = await seedApiKey(pool, tenantB.id, ['policy:admin']);

      // keyB must not revoke a key it can't see — use a UUID it cannot own.
      const listA = await fetch(`${harness.url}/v1/api-keys`, { headers: authHeaders(keyA) });
      const listABody = (await listA.json()) as { data: { items: Array<{ id: string }> } };
      const targetId = listABody.data.items[0].id;

      const cross = await fetch(`${harness.url}/v1/api-keys/${targetId}`, {
        method: 'DELETE',
        headers: authHeaders(keyB),
      });
      assert.equal(cross.status, 404);

      // Still present for tenant A.
      const stillThere = await fetch(`${harness.url}/v1/api-keys`, { headers: authHeaders(keyA) });
      const stillBody = (await stillThere.json()) as { data: { items: unknown[] } };
      assert.equal(stillBody.data.items.length, 1);
    });
  });

  describe('agent-builder reads', () => {
    it('lists owned principals with derived assurance_level', async () => {
      const tenantA = await seedTenant(pool, `ab-a-${Date.now()}`);
      const keyA = await seedApiKey(pool, tenantA.id, []);

      const subject = await seedSubject(pool, tenantA.id);
      // seedSubject's key (none) → assurance_level unknown. Add a control-verified key.
      await pool.query(
        `INSERT INTO principal_keys (principal_id, key_id, public_key_raw, public_key_jwk, key_hash, control_verified_at, valid_from)
         VALUES ($1, 'k1', decode('0102', 'hex'), '{}'::jsonb, 'verified-hash', now(), now())`,
        [subject.id]
      );

      const res = await fetch(`${harness.url}/v1/principals`, {
        headers: authHeaders(keyA),
      });
      const body = (await res.json()) as {
        data: { items: Array<{ id: string; assurance_level: string; owner_tenant_id: string }> };
      };
      assert.equal(res.status, 200, JSON.stringify(body));
      const owned = body.data.items.filter((p) => p.owner_tenant_id === tenantA.id);
      assert.equal(owned.length, 1);
      assert.equal(owned[0].id, subject.id);
      assert.equal(owned[0].assurance_level, 'verified_key');
    });

    it('includes issuer attrs on a principal detail when it is an issuer', async () => {
      const tenantA = await seedTenant(pool, `ab-iss-${Date.now()}`);
      const keyA = await seedApiKey(pool, tenantA.id, []);
      const issuer = await seedIssuer(pool, tenantA.id);

      const res = await fetch(`${harness.url}/v1/principals/${encodeURIComponent(issuer.id)}`, {
        headers: authHeaders(keyA),
      });
      const body = (await res.json()) as {
        data: { issuer: { trust_weight: number; verified_at: string | null; is_bootstrap: boolean } | null };
      };
      assert.equal(res.status, 200, JSON.stringify(body));
      assert.ok(body.data.issuer, 'issuer attrs present');
      assert.equal(body.data.issuer!.trust_weight, 1);
      assert.equal(body.data.issuer!.is_bootstrap, false);
    });

    it('omits issuer attrs for a plain agent', async () => {
      const tenantA = await seedTenant(pool, `ab-agent-${Date.now()}`);
      const keyA = await seedApiKey(pool, tenantA.id, []);
      const agent = await seedSubject(pool, tenantA.id);

      const res = await fetch(`${harness.url}/v1/principals/${encodeURIComponent(agent.id)}`, {
        headers: authHeaders(keyA),
      });
      const body = (await res.json()) as { data: { issuer: unknown } };
      assert.equal(res.status, 200);
      assert.equal(body.data.issuer, null);
    });
  });
});
