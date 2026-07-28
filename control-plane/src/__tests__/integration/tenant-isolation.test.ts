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
  seedApiKey,
  authHeaders,
  signAttestationToken,
} from '../../testutil/seedData.js';
import { startControlPlane, type ControlPlaneHarness } from '../../testutil/appHarness.js';

describe('Tenant Isolation Integration', () => {
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

  it('cross-tenant visibility: tenant B does not see tenant A participants attestations', async () => {
    const tenantA = await seedTenant(pool, `tenant-a-${Date.now()}`);
    const tenantB = await seedTenant(pool, `tenant-b-${Date.now()}`);

    const tenantAKey = await seedApiKey(pool, tenantA.id, ['attest:write', 'attest:read']);
    const tenantBKey = await seedApiKey(pool, tenantB.id, ['attest:read']);

    const issuerA = await seedIssuer(pool, tenantA.id);
    const subjectA = await seedSubject(pool, tenantA.id);

    const token = await signAttestationToken({
      issuerId: issuerA.id,
      subjectId: subjectA.id,
      privateKey: issuerA.privateKey,
      keyId: issuerA.keyId,
      visibility: 'participants',
    });

    const submitResp = await fetch(`${harness.url}/v1/attestations/submit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders(tenantAKey),
      },
      body: JSON.stringify({ token }),
    });
    assert.equal(submitResp.status, 201, await submitResp.text());

    const listResp = await fetch(
      `${harness.url}/v1/attestations?issuer_id=${encodeURIComponent(issuerA.id)}`,
      {
        headers: authHeaders(tenantBKey),
      }
    );
    assert.equal(listResp.status, 200);
    const data = (await listResp.json()) as {
      ok: boolean;
      data: { items: unknown[]; total: number };
    };
    assert.equal(data.ok, true);
    assert.equal(data.data.total, 0, 'Tenant B should not see Tenant A participants attestations');
    assert.equal(data.data.items.length, 0);
  });

  it('api-key tenant binding: tenant A cannot see tenant B attestations', async () => {
    const tenantA = await seedTenant(pool, `tenant-a-${Date.now()}`);
    const tenantB = await seedTenant(pool, `tenant-b-${Date.now()}`);

    const tenantAKey = await seedApiKey(pool, tenantA.id, ['attest:write', 'attest:read']);
    const tenantBKey = await seedApiKey(pool, tenantB.id, ['attest:write', 'attest:read']);

    const issuerA = await seedIssuer(pool, tenantA.id);
    const subjectA = await seedSubject(pool, tenantA.id);

    const issuerB = await seedIssuer(pool, tenantB.id);
    const subjectB = await seedSubject(pool, tenantB.id);

    const tokenA = await signAttestationToken({
      issuerId: issuerA.id,
      subjectId: subjectA.id,
      privateKey: issuerA.privateKey,
      keyId: issuerA.keyId,
      visibility: 'participants',
    });

    const tokenB = await signAttestationToken({
      issuerId: issuerB.id,
      subjectId: subjectB.id,
      privateKey: issuerB.privateKey,
      keyId: issuerB.keyId,
      visibility: 'participants',
    });

    const submitA = await fetch(`${harness.url}/v1/attestations/submit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders(tenantAKey),
      },
      body: JSON.stringify({ token: tokenA }),
    });
    assert.equal(submitA.status, 201, await submitA.text());

    const submitB = await fetch(`${harness.url}/v1/attestations/submit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders(tenantBKey),
      },
      body: JSON.stringify({ token: tokenB }),
    });
    assert.equal(submitB.status, 201, await submitB.text());

    // Tenant A should not be able to read Tenant B data, even when filtering by issuer_id.
    const listTenantBWithTenantAKey = await fetch(
      `${harness.url}/v1/attestations?issuer_id=${encodeURIComponent(issuerB.id)}`,
      {
        headers: authHeaders(tenantAKey),
      }
    );
    assert.equal(listTenantBWithTenantAKey.status, 200);
    const dataB = (await listTenantBWithTenantAKey.json()) as {
      ok: boolean;
      data: { items: unknown[]; total: number };
    };
    assert.equal(dataB.ok, true);
    assert.equal(dataB.data.total, 0);
    assert.equal(dataB.data.items.length, 0);

    // Unfiltered list should still only return Tenant A attestations.
    const listUnfilteredWithTenantAKey = await fetch(`${harness.url}/v1/attestations`, {
      headers: authHeaders(tenantAKey),
    });
    assert.equal(listUnfilteredWithTenantAKey.status, 200);
    const dataUnfiltered = (await listUnfilteredWithTenantAKey.json()) as {
      ok: boolean;
      data: { items: unknown[]; total: number };
    };
    assert.equal(dataUnfiltered.ok, true);
    assert.equal(dataUnfiltered.data.total, 1);
    assert.equal(dataUnfiltered.data.items.length, 1);
  });
});
