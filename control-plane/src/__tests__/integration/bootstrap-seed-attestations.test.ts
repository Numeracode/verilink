// control-plane/src/__tests__/integration/bootstrap-seed-attestations.test.ts
process.env.DATABASE_URL ||=
  'postgresql://verilink:verilink@127.0.0.1:15432/verilink_test';
process.env.API_KEY_HMAC_SECRET ||= 'test-hmac-secret-for-integration';

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type pg from 'pg';
import { setupTestDb, teardownTestDb, resetTestData } from '../../testutil/testDb.js';
import {
  seedTenant,
  seedApiKey,
  authHeaders,
} from '../../testutil/seedData.js';
import { startControlPlane, type ControlPlaneHarness } from '../../testutil/appHarness.js';
import { SEED_ISSUERS, SEED_AGENTS, BOOTSTRAP_KEY_ID } from '../../domains/bootstrap/seedManifest.js';
import { verifyAttestation, type KeyCandidate } from '../../grpc/trustEngineClient.js';

/**
 * Plan 10 PR B: seeded initial attestations from the VeriLink bootstrap issuer
 * to seeded agent subjects. Each attestation is a real signed JWS that passes
 * the normal verifier, with an immutable bootstrap_origin provenance flag.
 */
describe('Bootstrap Seed Attestations Integration', () => {
  let pool: pg.Pool;
  let harness: ControlPlaneHarness;
  let privateKeyJwk: string;

  let seedBootstrapRegistry: () => Promise<{
    issuers: number;
    roots: number;
    attestations: number;
    subjects: number;
  }>;
  let loadAttestationGraph: (evaluationTime: Date) => Promise<{
    roots: Array<{ id: string; weight: number }>;
    attestations: Array<{ issuer_id: string; subject_id: string; trust_delta: number }>;
    principals: Array<{ id: string }>;
  }>;

  before(async () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const pubJwk = publicKey.export({ format: 'jwk' }) as crypto.JsonWebKey;
    const privJwk = privateKey.export({ format: 'jwk' }) as crypto.JsonWebKey;

    // Override the manifest public key with our test keypair.
    // We do this by setting the env var and monkey-patching the manifest module.
    privateKeyJwk = JSON.stringify(privJwk);
    process.env.BOOTSTRAP_SEED_PRIVATE_KEY_JWK = privateKeyJwk;

    pool = await setupTestDb();
    harness = await startControlPlane();

    // Patch the manifest to use our test keypair before importing the seeder.
    const manifest = await import('../../domains/bootstrap/seedManifest.js');
    // The SEED_ISSUERS array is readonly, so we patch at the module level.
    // For integration tests, we update the issuer's key in the DB after seeding
    // to match our generated keypair.

    ({ seedBootstrapRegistry } = await import('../../domains/bootstrap/bootstrapSeeder.js'));
    ({ loadAttestationGraph } = await import('../../domains/graph/attestationGraphLoader.js'));
  });

  after(async () => {
    delete process.env.BOOTSTRAP_SEED_PRIVATE_KEY_JWK;
    await harness.stop();
    await teardownTestDb(pool);
  });

  beforeEach(async () => {
    await resetTestData(pool);
  });

  async function patchBootstrapIssuerKey(): Promise<void> {
    const pubJwk = crypto.createPublicKey(
      { key: JSON.parse(privateKeyJwk), format: 'jwk' }
    ).export({ format: 'jwk' }) as crypto.JsonWebKey;
    const publicKeyRaw = Buffer.from(pubJwk.x as string, 'base64url');
    const keyHash = crypto.createHash('sha256').update(publicKeyRaw).digest('hex');

    await pool.query(
      'UPDATE principal_keys SET public_key_raw = $1, public_key_jwk = $2, key_hash = $3 WHERE principal_id = $4 AND key_id = $5',
      [publicKeyRaw, JSON.stringify({ kty: 'OKP', crv: 'Ed25519', x: pubJwk.x }), keyHash, SEED_ISSUERS[0].id, BOOTSTRAP_KEY_ID],
    );
  }

  it('seed creates attestations with bootstrap_origin=true and they verify', async () => {
    const result = await seedBootstrapRegistry();
    assert.ok(result.attestations > 0, 'seed attestations created');
    assert.ok(result.subjects > 0, 'seed subjects created');

    // Patch the key in DB to match our test keypair (since manifest has committed key)
    await patchBootstrapIssuerKey();

    const { rows: attestations } = await pool.query(
      'SELECT id, issuer_id, subject_id, jws_token, trust_delta, attestation_type, schema_version, visibility, bootstrap_origin, verified_key_id FROM attestations WHERE bootstrap_origin = true ORDER BY subject_id',
    );
    assert.equal(attestations.length, SEED_AGENTS.length, 'one attestation per seed agent');

    for (const att of attestations) {
      assert.equal(att.issuer_id, SEED_ISSUERS[0].id, 'issuer is VeriLink bootstrap');
      assert.equal(att.bootstrap_origin, true, 'bootstrap_origin flag set');
      assert.equal(att.schema_version, '1', 'native v1 schema');
      assert.equal(att.visibility, 'public', 'seed attestations are public');
      assert.equal(att.verified_key_id, BOOTSTRAP_KEY_ID);
      assert.ok(att.trust_delta >= 0, 'trust_delta is non-negative');

      const agent = SEED_AGENTS.find((a) => a.id === att.subject_id);
      assert.ok(agent, 'subject matches a seed agent');
      assert.equal(att.attestation_type, agent.attestationType);
      assert.equal(att.trust_delta, agent.trustDelta);

      // Verify the JWS signature using the test keypair
      const candidateKeys: KeyCandidate[] = [{
        keyId: BOOTSTRAP_KEY_ID,
        publicKeyRaw: Buffer.from(
          (crypto.createPublicKey({ key: JSON.parse(privateKeyJwk), format: 'jwk' })
            .export({ format: 'jwk' }) as crypto.JsonWebKey).x as string,
          'base64url',
        ),
      }];
      const verifyResult = await verifyAttestation(att.jws_token, candidateKeys);
      assert.equal(verifyResult.valid, true, 'JWS signature verifies: ' + (verifyResult.error || ''));
      assert.equal(verifyResult.issuerId, SEED_ISSUERS[0].id);
      assert.equal(verifyResult.subjectId, att.subject_id);
    }
  });

  it('seed is idempotent: rerun does not duplicate attestations', async () => {
    const first = await seedBootstrapRegistry();
    assert.ok(first.attestations > 0);

    const { rows: afterFirst } = await pool.query(
      'SELECT count(*)::int AS n FROM attestations WHERE bootstrap_origin = true',
    );
    const count1 = afterFirst[0].n;

    const second = await seedBootstrapRegistry();
    const { rows: afterSecond } = await pool.query(
      'SELECT count(*)::int AS n FROM attestations WHERE bootstrap_origin = true',
    );
    assert.equal(afterSecond[0].n, count1, 'rerun is a no-op for attestations');
  });

  it('seeded attestations appear in the graph and agents get non-zero scores', async () => {
    await seedBootstrapRegistry();
    await patchBootstrapIssuerKey();

    const graph = await loadAttestationGraph(new Date());
    assert.ok(graph.roots.length > 0, 'graph has roots');
    assert.ok(graph.attestations.length > 0, 'graph has attestations');

    for (const agent of SEED_AGENTS) {
      const att = graph.attestations.find(
        (a) => a.subject_id === agent.id && a.issuer_id === SEED_ISSUERS[0].id,
      );
      assert.ok(att, 'seed attestation present in graph for agent ' + agent.name);
      assert.ok(att.trust_delta > 0, 'trust_delta > 0 for seed attestation');
    }

    const agentIds = new Set(SEED_AGENTS.map((a) => a.id));
    const graphAgentIds = graph.principals.map((p) => p.id);
    for (const agentId of agentIds) {
      assert.ok(graphAgentIds.includes(agentId), 'seed agent present in graph principals');
    }
  });

  it('bootstrap_origin flag survives issuer PATCH removal', async () => {
    await seedBootstrapRegistry();
    await patchBootstrapIssuerKey();

    const target = SEED_ISSUERS[0];
    const tenantA = await seedTenant(pool, 'bs-att-rm-' + Date.now());
    const staffKey = await seedApiKey(pool, tenantA.id, ['admin:read']);

    await fetch(harness.url + '/v1/admin/bootstrap-issuers', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...authHeaders(staffKey) },
      body: JSON.stringify({ principal_id: target.id, remove_from_registry: true }),
    });

    const { rows: attestations } = await pool.query(
      'SELECT bootstrap_origin FROM attestations WHERE issuer_id = $1',
      [target.id],
    );
    assert.ok(attestations.length > 0, 'attestations still exist after issuer removal');
    for (const att of attestations) {
      assert.equal(att.bootstrap_origin, true, 'bootstrap_origin flag is immutable after issuer removal');
    }
  });
});
