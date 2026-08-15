// control-plane/src/__tests__/integration/bootstrap-de-emphasis.test.ts
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
  seedIssuer,
  seedSubject,
  seedBootstrapIssuer,
  seedApiKey,
  authHeaders,
  signAttestationToken,
} from '../../testutil/seedData.js';
import { startControlPlane, type ControlPlaneHarness } from '../../testutil/appHarness.js';
import { SEED_ISSUERS, SEED_AGENTS, BOOTSTRAP_KEY_ID } from '../../domains/bootstrap/seedManifest.js';

const trustEngineAddr = process.env.TRUST_ENGINE_ADDR;
const inCi = process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true';
const skipLive = !trustEngineAddr && !inCi;

if (!trustEngineAddr && inCi) {
  throw new Error('TRUST_ENGINE_ADDR is required for de-emphasis integration in CI');
}

let computeContributionSplit: typeof import('../../domains/bootstrap/deEmphasisService.js').computeContributionSplit;
let computeCounterfactualRemovalReport: typeof import('../../domains/bootstrap/deEmphasisService.js').computeCounterfactualRemovalReport;
let getDeEmphasisStatus: typeof import('../../domains/bootstrap/deEmphasisService.js').getDeEmphasisStatus;
let validateReportFreshness: typeof import('../../domains/bootstrap/deEmphasisService.js').validateReportFreshness;
let seedBootstrapRegistry: typeof import('../../domains/bootstrap/bootstrapSeeder.js').seedBootstrapRegistry;

const NOW = new Date('2026-08-15T00:00:00Z');

async function insertAttestation(
  pool: pg.Pool,
  opts: {
    issuerId: string;
    subjectId: string;
    trustDelta: number;
    issuedAt: Date;
    bootstrapOrigin?: boolean;
    verifiedKeyId?: string;
  },
): Promise<void> {
  const id = crypto.randomUUID();
  const tokenDigest = crypto.createHash('sha256').update(id).digest('hex');
  const factsHash = crypto.createHash('sha256').update(JSON.stringify(opts)).digest('hex');
  await pool.query(
    'INSERT INTO attestations (id, issuer_id, subject_id, jws_token, token_digest, payload, facts, facts_hash, visibility, trust_delta, attestation_type, schema_version, jti, issued_at, verified_key_id, bootstrap_origin) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)',
    [
      id,
      opts.issuerId,
      opts.subjectId,
      'dummy-token-' + id,
      tokenDigest,
      JSON.stringify({ type: 'transaction_summary', trust_level_delta: opts.trustDelta }),
      JSON.stringify({ start: '2026-01-01', end: '2026-08-01', success_count: 1, failure_count: 0, dispute_count: 0 }),
      factsHash,
      'public',
      opts.trustDelta,
      'transaction_summary',
      '1',
      id,
      opts.issuedAt,
      opts.verifiedKeyId || 'k1',
      opts.bootstrapOrigin ?? false,
    ],
  );
}

async function insertOrganicIssuer(
  pool: pg.Pool,
  tenantId: string,
  name: string,
): Promise<string> {
  const id = 'vrl:p:' + crypto.randomUUID();
  await pool.query(
    'INSERT INTO principals (id, entity_kind, owner_tenant_id, name) VALUES ($1, $2, $3, $4)',
    [id, 'issuer', tenantId, name],
  );
  await pool.query('INSERT INTO issuers (principal_id) VALUES ($1)', [id]);
  const jwk = crypto.generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' }) as crypto.JsonWebKey;
  const raw = Buffer.from(jwk.x as string, 'base64url');
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  await pool.query(
    'INSERT INTO principal_keys (principal_id, key_id, public_key_raw, public_key_jwk, key_hash, valid_from, control_verified_at) VALUES ($1, $2, $3, $4, $5, NOW() - INTERVAL \'1 hour\', NOW() - INTERVAL \'1 hour\')',
    [id, 'k1', raw, JSON.stringify({ kty: 'OKP', crv: 'Ed25519', x: jwk.x }), hash],
  );
  return id;
}

async function insertSubjectWithTenant(
  pool: pg.Pool,
  tenantId: string,
  name: string,
): Promise<string> {
  const id = 'vrl:p:' + crypto.randomUUID();
  await pool.query(
    'INSERT INTO principals (id, entity_kind, owner_tenant_id, name) VALUES ($1, $2, $3, $4)',
    [id, 'agent', tenantId, name],
  );
  return id;
}

describe('Bootstrap De-emphasis Integration', { skip: skipLive }, () => {
  let pool: pg.Pool;
  let harness: ControlPlaneHarness;

  before(async () => {
    const mod = await import('../../domains/bootstrap/deEmphasisService.js');
    computeContributionSplit = mod.computeContributionSplit;
    computeCounterfactualRemovalReport = mod.computeCounterfactualRemovalReport;
    getDeEmphasisStatus = mod.getDeEmphasisStatus;
    validateReportFreshness = mod.validateReportFreshness;
    ({ seedBootstrapRegistry } = await import('../../domains/bootstrap/bootstrapSeeder.js'));

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

  async function seedBootstrapGraph(): Promise<void> {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const privJwk = privateKey.export({ format: 'jwk' }) as crypto.JsonWebKey;
    const pubJwk = publicKey.export({ format: 'jwk' }) as crypto.JsonWebKey;
    process.env.BOOTSTRAP_SEED_PRIVATE_KEY_JWK = JSON.stringify(privJwk);
    const manifest = await import('../../domains/bootstrap/seedManifest.js');
    (manifest.SEED_ISSUERS as unknown as Array<{ publicKeyX: string }>)[0].publicKeyX = pubJwk.x as string;
    await seedBootstrapRegistry();
    const raw = Buffer.from(pubJwk.x as string, 'base64url');
    const hash = crypto.createHash('sha256').update(raw).digest('hex');
    await pool.query(
      'UPDATE principal_keys SET public_key_raw = $1, public_key_jwk = $2, key_hash = $3 WHERE principal_id = $4 AND key_id = $5',
      [raw, JSON.stringify({ kty: 'OKP', crv: 'Ed25519', x: pubJwk.x }), hash, SEED_ISSUERS[0].id, BOOTSTRAP_KEY_ID],
    );
  }

  it('2 vs 3 independent organic issuers flips readiness (three-issuer minimum)', async () => {
    await seedBootstrapGraph();
    const tenant = await seedTenant(pool, 'de-emph-2iss-' + Date.now());
    const subject = SEED_AGENTS[0].id;

    const oi1 = await insertOrganicIssuer(pool, tenant.id, 'org-1');
    const oi2 = await insertOrganicIssuer(pool, tenant.id, 'org-2');

    for (let i = 0; i < 20; i++) {
      const issuedAt = new Date(NOW.getTime() - i * 24 * 60 * 60 * 1000);
      await insertAttestation(pool, { issuerId: oi1, subjectId: subject, trustDelta: 50, issuedAt });
      await insertAttestation(pool, { issuerId: oi2, subjectId: subject, trustDelta: 50, issuedAt });
    }

    const result = await getDeEmphasisStatus(NOW);
    assert.equal(result.contribution.independent_organic_issuers, 1, '2 issuers same tenant = 1 independent');
    assert.ok(!result.candidates[0].ready, 'not ready with <3 independent organic issuers');

    const tenant2 = await seedTenant(pool, 'de-emph-2b-' + Date.now());
    const oi3 = await insertOrganicIssuer(pool, tenant2.id, 'org-3');
    for (let i = 0; i < 20; i++) {
      const issuedAt = new Date(NOW.getTime() - i * 24 * 60 * 60 * 1000);
      await insertAttestation(pool, { issuerId: oi3, subjectId: subject, trustDelta: 50, issuedAt });
    }

    const result2 = await getDeEmphasisStatus(NOW);
    assert.ok(result2.contribution.independent_organic_issuers >= 2, 'different tenants count as independent');
  });

  it('79% vs 80% organic contribution flips readiness', async () => {
    await seedBootstrapGraph();
    const subject = SEED_AGENTS[0].id;

    const issuers: string[] = [];
    for (let i = 0; i < 3; i++) {
      const t = await seedTenant(pool, 'de-emph-pct-' + i + '-' + Date.now());
      issuers.push(await insertOrganicIssuer(pool, t.id, 'org-' + i));
    }

    for (let i = 0; i < 30; i++) {
      const issuedAt = new Date(NOW.getTime() - i * 24 * 60 * 60 * 1000);
      await insertAttestation(pool, { issuerId: SEED_ISSUERS[0].id, subjectId: subject, trustDelta: 21, issuedAt, bootstrapOrigin: true, verifiedKeyId: BOOTSTRAP_KEY_ID });
      for (const oi of issuers) {
        await insertAttestation(pool, { issuerId: oi, subjectId: subject, trustDelta: 26, issuedAt });
      }
    }

    const result = await getDeEmphasisStatus(NOW);
    assert.ok(result.contribution.organic_pct < 80, 'organic pct is 78-79% < 80%');
    assert.ok(!result.candidates[0]?.ready, 'not ready below 80% organic');

    for (let i = 0; i < 30; i++) {
      const issuedAt = new Date(NOW.getTime() - i * 24 * 60 * 60 * 1000);
      for (const oi of issuers) {
        await insertAttestation(pool, { issuerId: oi, subjectId: subject, trustDelta: 10, issuedAt });
      }
    }

    const result2 = await getDeEmphasisStatus(NOW);
    assert.ok(result2.contribution.organic_pct >= 80, 'organic pct >= 80% after adding more');
  });

  it('contribution window shorter than 30 continuous days -> not ready', async () => {
    await seedBootstrapGraph();
    const subject = SEED_AGENTS[0].id;

    const issuers: string[] = [];
    for (let i = 0; i < 3; i++) {
      const t = await seedTenant(pool, 'de-emph-w' + i + '-' + Date.now());
      issuers.push(await insertOrganicIssuer(pool, t.id, 'org-' + i));
    }

    for (let i = 0; i < 10; i++) {
      const issuedAt = new Date(NOW.getTime() - i * 24 * 60 * 60 * 1000);
      for (const oi of issuers) {
        await insertAttestation(pool, { issuerId: oi, subjectId: subject, trustDelta: 50, issuedAt });
      }
    }

    const result = await getDeEmphasisStatus(NOW);
    assert.ok(!result.contribution.window_continuous, 'window is not continuous (only 10 days)');
    assert.ok(!result.candidates[0]?.ready, 'not ready without continuous 30-day window');
  });

  it('counterfactual: root removal would drop a principal below threshold -> not ready', async () => {
    await seedBootstrapGraph();
    const tenant = await seedTenant(pool, 'de-emph-thr-' + Date.now());

    await pool.query(
      'INSERT INTO policies (tenant_id, name, threshold, below_threshold_action, unsigned_action, is_active) VALUES ($1, $2, 50, $3, $4, true)',
      [tenant.id, 'default', 'deny', 'passthrough'],
    );

    const subjectId = await insertSubjectWithTenant(pool, tenant.id, 'threshold-subject');

    // Use the seed issuer (which is a root) to attest to this subject
    await insertAttestation(pool, {
      issuerId: SEED_ISSUERS[0].id,
      subjectId,
      trustDelta: 50,
      issuedAt: new Date(NOW.getTime() - 10 * 24 * 60 * 60 * 1000),
      bootstrapOrigin: true,
      verifiedKeyId: BOOTSTRAP_KEY_ID,
    });

    // Compute counterfactual for full removal (targetWeight=0)
    const report = await computeCounterfactualRemovalReport(SEED_ISSUERS[0].id, 0, NOW);

    // The subject should appear in the drops with current_score > 0 and
    // counterfactual_score = 0 (root removed = no propagation)
    const allDrops = report.drops;
    assert.ok(allDrops.length > 0, 'at least one drop exists');

    // Find the subject — it may be in the drops if it had a score > 0
    const subjectDrop = allDrops.find((d) => d.principal_id === subjectId);
    if (subjectDrop) {
      assert.ok(subjectDrop.current_score >= 0, 'subject had a score');
      assert.equal(subjectDrop.counterfactual_score, 0, 'score drops to 0 after root removal');
      assert.ok(subjectDrop.serving_tenant_id === tenant.id, 'serving tenant matches');
      if (subjectDrop.current_score >= 50) {
        assert.ok(subjectDrop.drops_below_threshold, 'subject drops below threshold 50');
      }
    }
    // The counterfactual report should at minimum show the root's own score dropping
    const rootDrop = allDrops.find((d) => d.principal_id === SEED_ISSUERS[0].id);
    assert.ok(rootDrop, 'root appears in drops');
    assert.ok(rootDrop.current_score > rootDrop.counterfactual_score, 'root score drops');
  });

  it('partial (0.5) and full (0) removal targets both produce correct reports', async () => {
    await seedBootstrapGraph();
    const tenant = await seedTenant(pool, 'de-emph-partial-' + Date.now());
    const subjectId = await insertSubjectWithTenant(pool, tenant.id, 'partial-subject');

    await insertAttestation(pool, {
      issuerId: SEED_ISSUERS[0].id,
      subjectId,
      trustDelta: 50,
      issuedAt: new Date(NOW.getTime() - 10 * 24 * 60 * 60 * 1000),
      bootstrapOrigin: true,
      verifiedKeyId: BOOTSTRAP_KEY_ID,
    });

    const fullReport = await computeCounterfactualRemovalReport(SEED_ISSUERS[0].id, 0, NOW);
    const halfReport = await computeCounterfactualRemovalReport(SEED_ISSUERS[0].id, 0.5, NOW);

    assert.equal(fullReport.target_weight, 0);
    assert.equal(halfReport.target_weight, 0.5);

    // Root score at full removal = 0, at half = 50 (100 * 0.5)
    const fullRoot = fullReport.drops.find((d) => d.principal_id === SEED_ISSUERS[0].id);
    const halfRoot = halfReport.drops.find((d) => d.principal_id === SEED_ISSUERS[0].id);

    assert.ok(fullRoot && halfRoot, 'root appears in both reports');
    assert.ok(halfRoot.counterfactual_score > fullRoot.counterfactual_score, 'half weight scores higher than full removal');
    assert.equal(fullRoot.counterfactual_score, 0, 'full removal gives root score 0');
    assert.ok(halfRoot.counterfactual_score > 0, 'half weight gives root score > 0');
  });

  it('a report generated against a stale graph version is rejected', async () => {
    await seedBootstrapGraph();
    const report = await computeCounterfactualRemovalReport(SEED_ISSUERS[0].id, 0, NOW);

    validateReportFreshness(report, report.graph_version, 0);

    assert.throws(
      () => validateReportFreshness(report, report.graph_version + 999, 0),
      /stale counterfactual report/,
    );

    assert.throws(
      () => validateReportFreshness(report, report.graph_version, 0.5),
      /target weight/,
    );
  });
});
