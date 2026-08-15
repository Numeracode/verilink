// control-plane/src/domains/bootstrap/seedAttestations.ts

import { createHash, createPrivateKey, type KeyObject } from 'node:crypto';
import { SignJWT } from 'jose';
import type pg from 'pg';
import { SEED_ISSUERS, SEED_AGENTS, BOOTSTRAP_KEY_ID } from './seedManifest.js';
import { computeFactsHash } from '../attestation/canonicalize.js';

const BOOTSTRAP_ISSUER_ID = SEED_ISSUERS[0].id;

function loadBootstrapPrivateKey(): KeyObject {
  const jwkJson = process.env.BOOTSTRAP_SEED_PRIVATE_KEY_JWK;
  if (!jwkJson) {
    throw new Error(
      'BOOTSTRAP_SEED_PRIVATE_KEY_JWK not set. ' +
        'Seed attestations require the VeriLink bootstrap issuer private key ' +
        '(see .env.dev-keys for local dev).'
    );
  }
  const jwk = JSON.parse(jwkJson) as Record<string, string>;
  return createPrivateKey({ key: jwk, format: 'jwk' });
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

async function upsertSeedSubject(
  client: pg.PoolClient,
  agentId: string,
  agentName: string,
): Promise<void> {
  await client.query(
    'INSERT INTO principals (id, entity_kind, owner_tenant_id, name, metadata) VALUES ($1, \'agent\', NULL, $2, $3) ON CONFLICT (id) DO NOTHING',
    [agentId, agentName, JSON.stringify({ bootstrap_seed: true })],
  );
}

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
): Promise<void> {
  const existing = await client.query(
    'SELECT id FROM attestations WHERE token_digest = $1',
    [opts.tokenDigest],
  );
  if (existing.rows.length > 0) return;

  await client.query(
    'INSERT INTO attestations (issuer_id, subject_id, jws_token, token_digest, payload, facts, facts_hash, visibility, trust_delta, attestation_type, schema_version, jti, observation_id, issued_at, expires_at, verified_key_id, bootstrap_origin) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NULL,$13,NULL,$14, true)',
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
 * Idempotent: uses deterministic token_digest (sha256 of the JWS token) and
 * skips if the attestation already exists.
 */
export async function seedBootstrapAttestations(
  client: pg.PoolClient,
): Promise<SeedAttestationResult> {
  const privateKey = loadBootstrapPrivateKey();
  const issuedAtUnix = Math.floor(new Date('2026-08-01T00:00:00Z').getTime() / 1000);
  const issuedAt = new Date(issuedAtUnix * 1000);
  let attestationCount = 0;
  let subjectCount = 0;

  for (const agent of SEED_AGENTS) {
    await upsertSeedSubject(client, agent.id, agent.name);
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

    await insertSeedAttestation(client, {
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
    attestationCount++;
  }

  return { attestations: attestationCount, subjects: subjectCount };
}
