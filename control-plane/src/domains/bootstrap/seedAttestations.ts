// control-plane/src/domains/bootstrap/seedAttestations.ts

import { createHash, createPrivateKey, createPublicKey, type KeyObject } from 'node:crypto';
import { SignJWT } from 'jose';
import type pg from 'pg';
import { SEED_ISSUERS, SEED_AGENTS, BOOTSTRAP_KEY_ID } from './seedManifest.js';
import { computeFactsHash } from '../attestation/canonicalize.js';

const BOOTSTRAP_ISSUER_ID = SEED_ISSUERS[0].id;

/**
 * Load the bootstrap issuer private key from env and validate its public key
 * against the committed manifest entry (CodeRabbit: key-manifest binding).
 * Rejects mismatches before any DB writes so a wrong key never seeds.
 */
function loadAndValidateBootstrapPrivateKey(): KeyObject {
  const jwkJson = process.env.BOOTSTRAP_SEED_PRIVATE_KEY_JWK;
  if (!jwkJson) {
    throw new Error(
      'BOOTSTRAP_SEED_PRIVATE_KEY_JWK not set. ' +
        'Seed attestations require the VeriLink bootstrap issuer private key ' +
        '(see .env.dev-keys for local dev).',
    );
  }
  const jwk = JSON.parse(jwkJson) as Record<string, string>;
  const privateKey = createPrivateKey({ key: jwk, format: 'jwk' });

  const derivedPublic = privateKey.export({ format: 'jwk' }) as Record<string, string>;
  const manifestX = SEED_ISSUERS[0].publicKeyX;
  if (derivedPublic.x !== manifestX) {
    throw new Error(
      'BOOTSTRAP_SEED_PRIVATE_KEY_JWK public key mismatch: ' +
        'derived x=' + derivedPublic.x + ', manifest x=' + manifestX,
    );
  }

  return privateKey;
}

async function signSeedAttestation(opts: {
  issuerId: string;
  subjectId: string;
  keyId: string;
  privateKey: KeyObject;
  attestationType: string;
  trustDelta: number;
  facts: Record<string, unknown>;
  issuedAtUnix: number;
}): Promise<string> {
  return new SignJWT({
    vli: {
      type: opts.attestationType,
      facts: opts.facts,
      trust_level_delta: opts.trustDelta,
      schema_version: '1',
      visibility: 'public',
    },
  })
    .setProtectedHeader({ alg: 'EdDSA', kid: opts.keyId })
    .setIssuer(opts.issuerId)
    .setSubject(opts.subjectId)
    .setIssuedAt(opts.issuedAtUnix)
    .setJti('bootstrap-seed-' + opts.subjectId)
    .sign(opts.privateKey);
}

function sha256hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

/**
 * Upsert a seed agent subject with conflict validation (matches upsertSeedIssuer
 * pattern): if the principal already exists with mismatched entity_kind, name,
 * or owner_tenant_id, abort the transaction rather than silently reuse it.
 */
async function upsertSeedSubject(
  client: pg.PoolClient,
  agentId: string,
  agentName: string,
  entityKind: string,
): Promise<void> {
  const { rows: existing } = await client.query(
    'SELECT entity_kind, owner_tenant_id, name FROM principals WHERE id = $1',
    [agentId],
  );
  if (existing.length > 0) {
    const p = existing[0];
    if (p.entity_kind !== entityKind || p.name !== agentName) {
      throw new Error(
        'bootstrap seed conflict: principal ' + agentId +
        ' exists with entity_kind=' + p.entity_kind + ' name=' + p.name +
        ', manifest expects entity_kind=' + entityKind + ' name=' + agentName,
      );
    }
    if (p.owner_tenant_id !== null) {
      throw new Error(
        'bootstrap seed conflict: principal ' + agentId +
        ' is owned by tenant ' + p.owner_tenant_id + ', seed agents must be unowned',
      );
    }
  }

  await client.query(
    'INSERT INTO principals (id, entity_kind, owner_tenant_id, name, metadata) VALUES ($1, $2, NULL, $3, $4) ON CONFLICT (id) DO NOTHING',
    [agentId, entityKind, agentName, JSON.stringify({ bootstrap_seed: true })],
  );
}

/**
 * Insert a seed attestation using INSERT ... ON CONFLICT (token_digest) DO
 * NOTHING to avoid the SELECT-then-INSERT race. Returns true if a new row was
 * inserted, false if it already existed (idempotent count — CodeRabbit finding).
 */
async function insertSeedAttestation(
  client: pg.PoolClient,
  opts: {
    issuerId: string;
    subjectId: string;
    jwsToken: string;
    tokenDigest: string;
    factsHash: string;
    facts: Record<string, unknown>;
    trustDelta: number;
    attestationType: string;
    verifiedKeyId: string;
    issuedAt: Date;
  },
): Promise<boolean> {
  const { rows } = await client.query(
    'INSERT INTO attestations (issuer_id, subject_id, jws_token, token_digest, payload, facts, facts_hash, visibility, trust_delta, attestation_type, schema_version, jti, observation_id, issued_at, expires_at, verified_key_id, bootstrap_origin) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NULL,$13,NULL,$14, true) ON CONFLICT (token_digest) DO NOTHING RETURNING id',
    [
      opts.issuerId,
      opts.subjectId,
      opts.jwsToken,
      opts.tokenDigest,
      JSON.stringify({
        type: opts.attestationType,
        facts: opts.facts,
        trust_level_delta: opts.trustDelta,
        schema_version: '1',
        visibility: 'public',
      }),
      JSON.stringify(opts.facts),
      opts.factsHash,
      'public',
      opts.trustDelta,
      opts.attestationType,
      '1',
      'bootstrap-seed-' + opts.subjectId,
      opts.issuedAt,
      opts.verifiedKeyId,
    ],
  );
  return rows.length > 0;
}

export interface SeedAttestationResult {
  attestations: number;
  subjects: number;
}

/**
 * Seed initial attestations from the VeriLink bootstrap issuer to seed agent
 * subjects (Plan 10 PR B, decision 5-7). Each attestation is a real signed JWS
 * over the RFC 8785 JCS facts payload that passes the normal verifier, with an
 * immutable bootstrap_origin provenance flag.
 *
 * Idempotent: INSERT ... ON CONFLICT (token_digest) DO NOTHING; the count
 * reflects only newly inserted rows.
 */
export async function seedBootstrapAttestations(
  client: pg.PoolClient,
): Promise<SeedAttestationResult> {
  const privateKey = loadAndValidateBootstrapPrivateKey();
  const issuedAtUnix = Math.floor(new Date('2026-08-01T00:00:00Z').getTime() / 1000);
  const issuedAt = new Date(issuedAtUnix * 1000);
  let attestationCount = 0;
  let subjectCount = 0;

  for (const agent of SEED_AGENTS) {
    await upsertSeedSubject(client, agent.id, agent.name, agent.entityKind);
    subjectCount++;

    const jwsToken = await signSeedAttestation({
      issuerId: BOOTSTRAP_ISSUER_ID,
      subjectId: agent.id,
      keyId: BOOTSTRAP_KEY_ID,
      privateKey,
      attestationType: agent.attestationType,
      trustDelta: agent.trustDelta,
      facts: agent.facts,
      issuedAtUnix,
    });

    const tokenDigest = sha256hex(jwsToken);
    const factsHash = computeFactsHash(agent.facts);

    const inserted = await insertSeedAttestation(client, {
      issuerId: BOOTSTRAP_ISSUER_ID,
      subjectId: agent.id,
      jwsToken,
      tokenDigest,
      factsHash,
      facts: agent.facts,
      trustDelta: agent.trustDelta,
      attestationType: agent.attestationType,
      verifiedKeyId: BOOTSTRAP_KEY_ID,
      issuedAt,
    });
    if (inserted) attestationCount++;
  }

  return { attestations: attestationCount, subjects: subjectCount };
}
