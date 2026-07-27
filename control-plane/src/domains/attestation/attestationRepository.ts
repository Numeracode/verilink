// control-plane/src/domains/attestation/attestationRepository.ts
import { pool } from '../../db/transaction.js';

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
}): Promise<Attestation> {
  const { rows } = await pool.query(
    `INSERT INTO attestations (
      issuer_id, subject_id, jws_token, token_digest, payload, facts,
      facts_hash, visibility, trust_delta, attestation_type, schema_version,
      jti, observation_id, issued_at, expires_at, verified_key_id
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
    RETURNING *`,
    [
      att.issuerId, att.subjectId, att.jwsToken, att.tokenDigest,
      JSON.stringify(att.payload), JSON.stringify(att.facts),
      att.factsHash, att.visibility, att.trustDelta, att.attestationType,
      att.schemaVersion, att.jti || null, att.observationId || null,
      att.issuedAt, att.expiresAt || null, att.verifiedKeyId,
    ]
  );
  return rows[0];
}

export async function findByTokenDigest(digest: string): Promise<Attestation | null> {
  const { rows } = await pool.query(
    'SELECT * FROM attestations WHERE token_digest = $1',
    [digest]
  );
  return rows[0] || null;
}

export async function listAttestations(opts: {
  issuerId?: string;
  subjectId?: string;
  limit?: number;
  offset?: number;
}): Promise<{ items: Attestation[]; total: number }> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  if (opts.issuerId) {
    conditions.push(`issuer_id = $${idx++}`);
    params.push(opts.issuerId);
  }
  if (opts.subjectId) {
    conditions.push(`subject_id = $${idx++}`);
    params.push(opts.subjectId);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = opts.limit || 50;
  const offset = opts.offset || 0;

  const countResult = await pool.query(`SELECT count(*) FROM attestations ${where}`, params);
  const total = parseInt(countResult.rows[0].count, 10);

  const { rows } = await pool.query(
    `SELECT * FROM attestations ${where} ORDER BY received_at DESC LIMIT $${idx++} OFFSET $${idx++}`,
    [...params, limit, offset]
  );

  return { items: rows, total };
}
