// control-plane/src/domains/attestation/attestationRepository.ts
import { createHash } from 'node:crypto';
import { pool } from '../../db/transaction.js';
import type { PoolClient } from 'pg';

export interface Attestation {
  id: string;
  issuer_id: string;
  subject_id: string;
  jws_token: string;
  token_digest: string;
  payload: Record<string, unknown>;
  facts: Record<string, unknown>;
  facts_hash: string;
  visibility: string;
  trust_delta: number;
  attestation_type: string;
  schema_version: string;
  jti: string | null;
  observation_id: string | null;
  issued_at: Date;
  expires_at: Date | null;
  sig_verified: boolean;
  verified_key_id: string;
  received_at: Date;
}

export async function createAttestation(att: {
  issuerId: string;
  subjectId: string;
  jwsToken: string;
  tokenDigest: string;
  payload: Record<string, unknown>;
  facts: Record<string, unknown>;
  factsHash: string;
  visibility: string;
  trustDelta: number;
  attestationType: string;
  schemaVersion: string;
  jti?: string;
  observationId?: string;
  issuedAt: Date;
  expiresAt?: Date;
  verifiedKeyId: string;
}, client?: PoolClient): Promise<Attestation> {
  const q = `INSERT INTO attestations (
      issuer_id, subject_id, jws_token, token_digest, payload, facts,
      facts_hash, visibility, trust_delta, attestation_type, schema_version,
      jti, observation_id, issued_at, expires_at, verified_key_id
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
    RETURNING *`;
  const params = [
      att.issuerId, att.subjectId, att.jwsToken, att.tokenDigest,
      JSON.stringify(att.payload), JSON.stringify(att.facts),
      att.factsHash, att.visibility, att.trustDelta, att.attestationType,
      att.schemaVersion, att.jti || null, att.observationId || null,
      att.issuedAt, att.expiresAt || null, att.verifiedKeyId,
    ];
  const { rows } = client
    ? await client.query(q, params)
    : await pool.query(q, params);
  return rows[0];
}

export async function findById(id: string): Promise<Attestation | null> {
  const { rows } = await pool.query('SELECT * FROM attestations WHERE id = $1', [id]);
  return rows[0] || null;
}

export async function findByTokenDigest(digest: string, client?: PoolClient): Promise<Attestation | null> {
  const q = 'SELECT * FROM attestations WHERE token_digest = $1';
  const { rows } = client ? await client.query(q, [digest]) : await pool.query(q, [digest]);
  return rows[0] || null;
}

export async function findObservationPeer(
  issuerId: string,
  subjectId: string,
  observationId: string,
  client?: PoolClient,
): Promise<Attestation | null> {
  // Advisory lock keyed by (issuer, subject, observation_id) to serialize
  // concurrent first-submissions for the same observation pair.
  if (client) {
    const lockKey = hashToLockKey(`${issuerId}:${subjectId}:${observationId}`);
    await client.query('SELECT pg_advisory_xact_lock($1, $2)', [lockKey.hi, lockKey.lo]);
  }
  const q = `SELECT * FROM attestations
     WHERE issuer_id = $1 AND subject_id = $2 AND observation_id = $3
     LIMIT 1`;
  const { rows } = client
    ? await client.query(q, [issuerId, subjectId, observationId])
    : await pool.query(q, [issuerId, subjectId, observationId]);
  return rows[0] || null;
}

function hashToLockKey(s: string): { hi: number; lo: number } {
  const hash = createHash('sha256').update(s).digest();
  // Split into two 32-bit ints for pg_advisory_xact_lock(hi, lo)
  // which takes two int4 args, avoiding bigint parameter issues
  return {
    hi: hash.readInt32BE(0),
    lo: hash.readInt32BE(4),
  };
}

export async function listAttestations(opts: {
  issuerId?: string;
  subjectId?: string;
  limit?: number;
  offset?: number;
  callerTenantIds?: string[];
  isStaff?: boolean;
}): Promise<{ items: Attestation[]; total: number }> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  if (opts.issuerId) {
    conditions.push(`a.issuer_id = $${idx++}`);
    params.push(opts.issuerId);
  }
  if (opts.subjectId) {
    conditions.push(`a.subject_id = $${idx++}`);
    params.push(opts.subjectId);
  }

  // Visibility filter: staff bypass all restrictions.
  // Participant-only facts visible only to callers who own the
  // issuer or subject principal (via owner_tenant_id). Public
  // attestations are visible to all callers.
  if (!opts.isStaff) {
    const tenantIds = opts.callerTenantIds || [];
    if (tenantIds.length > 0) {
      conditions.push(`(
        a.visibility = 'public'
        OR i.owner_tenant_id = ANY($${idx}::uuid[])
        OR s.owner_tenant_id = ANY($${idx}::uuid[])
      )`);
      params.push(tenantIds);
      idx++;
    } else {
      // No tenant context: public only
      conditions.push(`a.visibility = 'public'`);
    }
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = opts.limit || 50;
  const offset = opts.offset || 0;

  const countResult = await pool.query(
    `SELECT count(*) FROM attestations a
     LEFT JOIN principals i ON i.id = a.issuer_id
     LEFT JOIN principals s ON s.id = a.subject_id
     ${where}`,
    params
  );
  const total = parseInt(countResult.rows[0].count, 10);

  const { rows } = await pool.query(
    `SELECT a.* FROM attestations a
     LEFT JOIN principals i ON i.id = a.issuer_id
     LEFT JOIN principals s ON s.id = a.subject_id
     ${where} ORDER BY a.received_at DESC LIMIT $${idx++} OFFSET $${idx++}`,
    [...params, limit, offset]
  );

  return { items: rows, total };
}
