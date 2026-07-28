process.env.DATABASE_URL ||=
  'postgresql://verilink:verilink@127.0.0.1:15432/verilink_test';
process.env.API_KEY_HMAC_SECRET ||= 'test-hmac-secret-for-integration';

import crypto from 'node:crypto';
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

describe('Attestation Flow Integration', () => {
  let pool: pg.Pool;
  let harness: ControlPlaneHarness;
  let tenantId: string;
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
    const tenant = await seedTenant(pool, `tenant-${Date.now()}`);
    tenantId = tenant.id;
    apiKey = await seedApiKey(pool, tenantId, ['attest:write', 'attest:read']);
  });

  it('full attestation lifecycle: submit then list', async () => {
    const issuer = await seedIssuer(pool, tenantId);
    const subject = await seedSubject(pool, tenantId);
    const token = await signAttestationToken({
      issuerId: issuer.id,
      subjectId: subject.id,
      privateKey: issuer.privateKey,
      keyId: issuer.keyId,
    });

    const submitResp = await fetch(`${harness.url}/v1/attestations/submit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders(apiKey),
      },
      body: JSON.stringify({ token }),
    });
    assert.equal(submitResp.status, 201, await submitResp.text());

    // No-filter behavior: listing without query params should still succeed.
    const listRespNoFilter = await fetch(`${harness.url}/v1/attestations`, {
      headers: authHeaders(apiKey),
    });
    assert.equal(listRespNoFilter.status, 200);
    const bodyNoFilter = (await listRespNoFilter.json()) as {
      ok: boolean;
      data: { items: unknown[]; total: number };
    };
    assert.equal(bodyNoFilter.ok, true);
    assert.equal(bodyNoFilter.data.total, 1);
    assert.equal(bodyNoFilter.data.items.length, 1);

    const listResp = await fetch(
      `${harness.url}/v1/attestations?issuer_id=${encodeURIComponent(issuer.id)}`,
      {
        headers: authHeaders(apiKey),
      }
    );
    assert.equal(listResp.status, 200);
    const body = (await listResp.json()) as {
      ok: boolean;
      data: { items: unknown[]; total: number };
    };
    assert.equal(body.ok, true);
    assert.equal(body.data.total, 1);
    assert.equal(body.data.items.length, 1);
  });

  it('duplicate submission returns 409', async () => {
    const issuer = await seedIssuer(pool, tenantId);
    const subject = await seedSubject(pool, tenantId);
    const token = await signAttestationToken({
      issuerId: issuer.id,
      subjectId: subject.id,
      privateKey: issuer.privateKey,
      keyId: issuer.keyId,
    });

    const submitResp1 = await fetch(`${harness.url}/v1/attestations/submit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders(apiKey),
      },
      body: JSON.stringify({ token }),
    });
    assert.equal(submitResp1.status, 201, await submitResp1.text());

    const submitResp2 = await fetch(`${harness.url}/v1/attestations/submit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders(apiKey),
      },
      body: JSON.stringify({ token }),
    });
    assert.equal(submitResp2.status, 409);
  });

  it('invalid signature rejection returns 400', async () => {
    const issuer = await seedIssuer(pool, tenantId);
    const subject = await seedSubject(pool, tenantId);
    const signer = await seedIssuer(pool, tenantId);

    // The JWS is signed with `signer.privateKey`, but claims issuerId=issuer.id and kid=issuer.keyId.
    // Signature verification must fail against the issuer's stored public key.
    const token = await signAttestationToken({
      issuerId: issuer.id,
      subjectId: subject.id,
      privateKey: signer.privateKey,
      keyId: issuer.keyId,
      visibility: 'participants',
    });

    const submitResp = await fetch(`${harness.url}/v1/attestations/submit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders(apiKey),
      },
      body: JSON.stringify({ token }),
    });
    assert.equal(submitResp.status, 400);
  });

  it('unknown issuer rejection returns 400', async () => {
    const issuerId = `vrl:p:${crypto.randomUUID()}`;
    const subject = await seedSubject(pool, tenantId);
    const issuer = await seedIssuer(pool, tenantId);

    const token = await signAttestationToken({
      issuerId,
      subjectId: subject.id,
      privateKey: issuer.privateKey,
      keyId: issuer.keyId,
    });

    const submitResp = await fetch(`${harness.url}/v1/attestations/submit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders(apiKey),
      },
      body: JSON.stringify({ token }),
    });
    assert.equal(submitResp.status, 400);
  });

  it('schema violation rejection returns 400', async () => {
    const issuer = await seedIssuer(pool, tenantId);
    const subject = await seedSubject(pool, tenantId);

    const token = await signAttestationToken({
      issuerId: issuer.id,
      subjectId: subject.id,
      privateKey: issuer.privateKey,
      keyId: issuer.keyId,
      // Not in SUPPORTED_TYPES; validateSchema must reject with 400.
      attestationType: 'not_a_real_type',
    });

    const submitResp = await fetch(`${harness.url}/v1/attestations/submit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders(apiKey),
      },
      body: JSON.stringify({ token }),
    });
    assert.equal(submitResp.status, 400);
  });

  it('unauthorized request returns 401', async () => {
    const resp = await fetch(`${harness.url}/v1/attestations?issuer_id=vrl:p:dummy`, {
      headers: { 'Content-Type': 'application/json' },
    });
    assert.equal(resp.status, 401);
  });

  it('insufficient scope returns 403', async () => {
    const readOnlyKey = await seedApiKey(pool, tenantId, ['attest:read']);
    const resp = await fetch(`${harness.url}/v1/attestations/submit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders(readOnlyKey),
      },
      body: JSON.stringify({ token: 'not-a-real-token' }),
    });
    assert.equal(resp.status, 403);
  });
});
