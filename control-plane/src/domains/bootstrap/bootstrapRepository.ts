// control-plane/src/domains/bootstrap/bootstrapRepository.ts
import { pool } from '../../db/client.js';

export interface BootstrapIssuerRow {
  principal_id: string;
  name: string;
  current_weight: number;
  de_emphasis_reason: string | null;
  de_emphasized_at: Date | null;
  approved_by: string | null;
  seeded_at: Date;
  /** From issuers — read-only context for the queue. */
  trust_weight: number;
  verified_at: Date | null;
}

export async function listBootstrapIssuers(): Promise<BootstrapIssuerRow[]> {
  const { rows } = await pool.query(
    `SELECT b.principal_id, b.name, b.current_weight::float AS current_weight,
            b.de_emphasis_reason, b.de_emphasized_at, b.approved_by, b.seeded_at,
            i.trust_weight::float AS trust_weight, i.verified_at
     FROM bootstrap_issuers b
     JOIN issuers i ON i.principal_id = b.principal_id
     ORDER BY b.seeded_at ASC`
  );
  return rows as BootstrapIssuerRow[];
}

export interface BootstrapUpdate {
  current_weight?: number;
  de_emphasis_reason?: string | null;
  approved_by?: string | null;
}

/**
 * Staff edit of a bootstrap issuer's Root.weight + de-emphasis reason.
 * `issuers.trust_weight` is untouched (the orthogonal quality knob; de-emphasis
 * is via Root.weight only — design §4.5). Sets de_emphasized_at when a reason
 * is provided. Returns 404 via the caller when the row does not exist.
 */
export async function updateBootstrapIssuer(
  principalId: string,
  update: BootstrapUpdate
): Promise<BootstrapIssuerRow | null> {
  const sets: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  if (update.current_weight !== undefined) {
    sets.push(`current_weight = $${idx++}`);
    params.push(update.current_weight);
  }
  if (update.de_emphasis_reason !== undefined) {
    sets.push(`de_emphasis_reason = $${idx++}`);
    params.push(update.de_emphasis_reason);
    sets.push(`de_emphasized_at = $${idx++}`);
    params.push(update.de_emphasis_reason ? new Date() : null);
  }
  if (update.approved_by !== undefined) {
    sets.push(`approved_by = $${idx++}`);
    params.push(update.approved_by);
  }
  if (sets.length === 0) return null;

  params.push(principalId);
  const { rows } = await pool.query(
    `UPDATE bootstrap_issuers SET ${sets.join(', ')}
     WHERE principal_id = $${idx}
     RETURNING principal_id, name, current_weight::float AS current_weight,
               de_emphasis_reason, de_emphasized_at, approved_by, seeded_at`,
    params
  );
  if (rows.length === 0) return null;

  const row = rows[0];
  const issuer = await pool.query(
    `SELECT trust_weight::float AS trust_weight, verified_at FROM issuers WHERE principal_id = $1`,
    [principalId]
  );
  return {
    ...row,
    trust_weight: issuer.rows[0]?.trust_weight ?? 1,
    verified_at: issuer.rows[0]?.verified_at ?? null,
  };
}

export interface UnverifiedIssuerRow {
  principal_id: string;
  name: string | null;
  entity_kind: string;
  trust_weight: number;
  is_bootstrap: boolean;
  created_at: Date;
}

/** Issuer verification queue — issuers missing verified_at. */
export async function listUnverifiedIssuers(): Promise<UnverifiedIssuerRow[]> {
  const { rows } = await pool.query(
    `SELECT i.principal_id, p.name, p.entity_kind,
            i.trust_weight::float AS trust_weight, i.is_bootstrap, i.created_at
     FROM issuers i
     JOIN principals p ON p.id = i.principal_id
     WHERE i.verified_at IS NULL
     ORDER BY i.created_at ASC`
  );
  return rows as UnverifiedIssuerRow[];
}
