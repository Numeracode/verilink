process.env.DATABASE_URL ||=
  'postgresql://verilink:verilink@127.0.0.1:15432/verilink_test';
process.env.API_KEY_HMAC_SECRET ||= 'test-hmac-secret-for-integration';
process.env.STRIPE_PRICE_PRO ||= 'price_test_pro';

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type pg from 'pg';
import { setupTestDb, teardownTestDb, resetTestData } from '../../testutil/testDb.js';
import {
  seedTenant,
  seedIssuer,
  seedApiKey,
  seedBootstrapIssuer,
  authHeaders,
} from '../../testutil/seedData.js';
import { startControlPlane, type ControlPlaneHarness } from '../../testutil/appHarness.js';

/** Plan 9 PR D: billing (checkout/portal/webhook) + admin (tenants/bootstrap/issuer queue). */
describe('Billing + Admin Integration', () => {
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

  describe('billing', () => {
    it('creates a checkout session for a paid tier and 400s for free/unknown tiers', async () => {
      const tenantA = await seedTenant(pool, `bill-a-${Date.now()}`);
      const key = await seedApiKey(pool, tenantA.id, []);

      const okRes = await fetch(`${harness.url}/v1/billing/checkout-session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(key) },
        body: JSON.stringify({ tier: 'pro' }),
      });
      const okBody = (await okRes.json()) as { data: { url: string } };
      assert.equal(okRes.status, 200, JSON.stringify(okBody));
      assert.match(okBody.data.url, /checkout/);

      const freeRes = await fetch(`${harness.url}/v1/billing/checkout-session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(key) },
        body: JSON.stringify({ tier: 'free' }),
      });
      assert.equal(freeRes.status, 400);

      const unknownRes = await fetch(`${harness.url}/v1/billing/checkout-session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(key) },
        body: JSON.stringify({ tier: 'bogus' }),
      });
      assert.equal(unknownRes.status, 400);

      const unauth = await fetch(`${harness.url}/v1/billing/checkout-session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tier: 'pro' }),
      });
      assert.equal(unauth.status, 401);
    });

    it('portal-session: 404 without a subscription, 200 with one', async () => {
      const tenantA = await seedTenant(pool, `portal-a-${Date.now()}`);
      const key = await seedApiKey(pool, tenantA.id, []);

      const none = await fetch(`${harness.url}/v1/billing/portal-session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(key) },
        body: '{}',
      });
      assert.equal(none.status, 404);

      await pool.query(
        `INSERT INTO subscriptions (tenant_id, stripe_customer_id, stripe_subscription_id, plan, status)
         VALUES ($1, 'cus_test', 'sub_test', 'pro', 'active')`,
        [tenantA.id]
      );

      const okRes = await fetch(`${harness.url}/v1/billing/portal-session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(key) },
        body: '{}',
      });
      const okBody = (await okRes.json()) as { data: { url: string } };
      assert.equal(okRes.status, 200, JSON.stringify(okBody));
      assert.match(okBody.data.url, /portal/);
    });

    it('webhook: ingests checkout.session.completed idempotently (dedup on event id)', async () => {
      const tenantA = await seedTenant(pool, `wh-a-${Date.now()}`);
      const event = {
        id: 'evt_test_1',
        type: 'checkout.session.completed',
        data: { object: { customer: 'cus_test', subscription: 'sub_test', metadata: { tenant_id: tenantA.id, plan: 'pro' } } },
      };

      const res = await fetch(`${harness.url}/webhooks/stripe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(event),
      });
      const body = (await res.json()) as { data: { eventId: string; processed: boolean } };
      assert.equal(res.status, 200, JSON.stringify(body));
      assert.equal(body.data.processed, true);

      const { rows } = await pool.query(
        `SELECT stripe_subscription_id, plan, status FROM subscriptions WHERE tenant_id = $1`,
        [tenantA.id]
      );
      assert.equal(rows.length, 1, 'subscription row created');
      assert.equal(rows[0].stripe_subscription_id, 'sub_test');
      assert.equal(rows[0].plan, 'pro');
      assert.equal(rows[0].status, 'active');

      const replay = await fetch(`${harness.url}/webhooks/stripe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(event),
      });
      const replayBody = (await replay.json()) as { data: { processed: boolean } };
      assert.equal(replay.status, 200);
      assert.equal(replayBody.data.processed, false, 'replay is a no-op (dedup)');

      const { rows: after } = await pool.query(
        `SELECT count(*)::int AS n FROM subscriptions WHERE tenant_id = $1`,
        [tenantA.id]
      );
      assert.equal(after[0].n, 1, 'no duplicate subscription row');
    });

    it('webhook: updates an existing subscription on customer.subscription.updated', async () => {
      const tenantA = await seedTenant(pool, `wh-up-${Date.now()}`);
      await pool.query(
        `INSERT INTO subscriptions (tenant_id, stripe_customer_id, stripe_subscription_id, plan, status)
         VALUES ($1, 'cus_test', 'sub_test', 'pro', 'active')`,
        [tenantA.id]
      );
      const event = {
        id: 'evt_test_2',
        type: 'customer.subscription.updated',
        data: { object: { id: 'sub_test', customer: 'cus_test', status: 'past_due', metadata: { tenant_id: tenantA.id, plan: 'pro' }, current_period_end: 1893456000 } },
      };

      const res = await fetch(`${harness.url}/webhooks/stripe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(event),
      });
      assert.equal(res.status, 200);

      const { rows } = await pool.query(
        `SELECT status, current_period_end FROM subscriptions WHERE tenant_id = $1 AND stripe_subscription_id = 'sub_test'`,
        [tenantA.id]
      );
      assert.equal(rows.length, 1);
      assert.equal(rows[0].status, 'past_due');
      assert.ok(rows[0].current_period_end, 'period end persisted');
    });
  });

  describe('admin', () => {
    it('GET /v1/tenants: staff sees all, tenant key sees only its own', async () => {
      const tenantA = await seedTenant(pool, `ten-a-${Date.now()}`);
      const tenantB = await seedTenant(pool, `ten-b-${Date.now()}`);
      const staffKey = await seedApiKey(pool, tenantA.id, ['admin:read']);
      const tenantKey = await seedApiKey(pool, tenantB.id, []);

      const staffRes = await fetch(`${harness.url}/v1/tenants`, { headers: authHeaders(staffKey) });
      const staffBody = (await staffRes.json()) as { data: { items: Array<{ id: string }> } };
      assert.equal(staffRes.status, 200, JSON.stringify(staffBody));
      assert.ok(staffBody.data.items.length >= 2, 'staff sees all tenants');

      const tenantRes = await fetch(`${harness.url}/v1/tenants`, { headers: authHeaders(tenantKey) });
      const tenantBody = (await tenantRes.json()) as { data: { items: Array<{ id: string }> } };
      assert.equal(tenantRes.status, 200);
      assert.equal(tenantBody.data.items.length, 1, 'non-staff sees only its tenant');
      assert.equal(tenantBody.data.items[0].id, tenantB.id);
    });

    it('GET /v1/admin/bootstrap-issuers requires staff', async () => {
      const tenantA = await seedTenant(pool, `bs-a-${Date.now()}`);
      const staffKey = await seedApiKey(pool, tenantA.id, ['admin:read']);
      const tenantKey = await seedApiKey(pool, tenantA.id, []);

      const issuer = await seedIssuer(pool, tenantA.id);
      await seedBootstrapIssuer(pool, issuer.id, { name: 'root-1' });

      const staffRes = await fetch(`${harness.url}/v1/admin/bootstrap-issuers`, { headers: authHeaders(staffKey) });
      const staffBody = (await staffRes.json()) as { data: { items: Array<{ principal_id: string; current_weight: number }> } };
      assert.equal(staffRes.status, 200, JSON.stringify(staffBody));
      assert.equal(staffBody.data.items.length, 1);
      assert.equal(staffBody.data.items[0].current_weight, 1);

      const forbidden = await fetch(`${harness.url}/v1/admin/bootstrap-issuers`, { headers: authHeaders(tenantKey) });
      assert.equal(forbidden.status, 403);
    });

    it('PATCH /v1/admin/bootstrap-issuers edits weight + reason (404 for unknown)', async () => {
      const tenantA = await seedTenant(pool, `bs-patch-${Date.now()}`);
      const staffKey = await seedApiKey(pool, tenantA.id, ['admin:read']);
      const issuer = await seedIssuer(pool, tenantA.id);
      await seedBootstrapIssuer(pool, issuer.id, { name: 'root-1' });

      const res = await fetch(`${harness.url}/v1/admin/bootstrap-issuers`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...authHeaders(staffKey) },
        body: JSON.stringify({ principal_id: issuer.id, current_weight: 0.5, de_emphasis_reason: 'organic volume' }),
      });
      const body = (await res.json()) as { data: { issuer: { current_weight: number; de_emphasis_reason: string | null } } };
      assert.equal(res.status, 200, JSON.stringify(body));
      assert.equal(body.data.issuer.current_weight, 0.5);
      assert.equal(body.data.issuer.de_emphasis_reason, 'organic volume');

      const { rows } = await pool.query(
        `SELECT current_weight::float AS w, de_emphasis_reason, approved_by, de_emphasized_at FROM bootstrap_issuers WHERE principal_id = $1`,
        [issuer.id]
      );
      assert.equal(rows[0].w, 0.5);
      assert.ok(rows[0].de_emphasized_at, 'de_emphasized_at set');

      const badWeight = await fetch(`${harness.url}/v1/admin/bootstrap-issuers`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...authHeaders(staffKey) },
        body: JSON.stringify({ principal_id: issuer.id, current_weight: 2 }),
      });
      assert.equal(badWeight.status, 400);

      const missing = await fetch(`${harness.url}/v1/admin/bootstrap-issuers`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...authHeaders(staffKey) },
        body: JSON.stringify({ principal_id: 'vrl:p:00000000-0000-0000-0000-000000000000', current_weight: 0.25 }),
      });
      assert.equal(missing.status, 404);
    });

    it('GET /v1/admin/issuers/unverified lists issuers missing verified_at', async () => {
      const tenantA = await seedTenant(pool, `unv-a-${Date.now()}`);
      const staffKey = await seedApiKey(pool, tenantA.id, ['admin:read']);
      // seedIssuer leaves verified_at null → appears in the queue.
      const unverified = await seedIssuer(pool, tenantA.id);

      const res = await fetch(`${harness.url}/v1/admin/issuers/unverified`, { headers: authHeaders(staffKey) });
      const body = (await res.json()) as { data: { items: Array<{ principal_id: string }> } };
      assert.equal(res.status, 200, JSON.stringify(body));
      assert.ok(body.data.items.some((i) => i.principal_id === unverified.id));

      // Mark verified → leaves the queue.
      await pool.query(`UPDATE issuers SET verified_at = now() WHERE principal_id = $1`, [unverified.id]);
      const after = await fetch(`${harness.url}/v1/admin/issuers/unverified`, { headers: authHeaders(staffKey) });
      const afterBody = (await after.json()) as { data: { items: Array<{ principal_id: string }> } };
      assert.ok(!afterBody.data.items.some((i) => i.principal_id === unverified.id));
    });
  });
});
