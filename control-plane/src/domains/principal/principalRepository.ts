// control-plane/src/domains/principal/principalRepository.ts
import { pool, withTransaction } from '../../db/transaction.js';

export interface Principal {
  id: string;
  entity_kind: string;
  name: string | null;
  owner_tenant_id: string | null;
  metadata: Record<string, unknown>;
  first_seen_at: Date;
  last_seen_at: Date;
  status: string;
}

export interface PrincipalKey {
  principal_id: string;
  key_id: string;
  public_key_raw: Buffer;
  public_key_jwk: Record<string, unknown>;
  key_hash: string;
  control_verified_at: Date | null;
  valid_from: Date;
  valid_until: Date | null;
  revoked_at: Date | null;
}

export async function createPrincipal(
  id: string,
  entityKind: string,
  ownerTenantId?: string,
  name?: string
): Promise<Principal> {
  const { rows } = await pool.query(
    `INSERT INTO principals (id, entity_kind, owner_tenant_id, name)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [id, entityKind, ownerTenantId || null, name || null]
  );
  return rows[0];
}

export async function getPrincipal(id: string): Promise<Principal | null> {
  const { rows } = await pool.query('SELECT * FROM principals WHERE id = $1', [id]);
  return rows[0] || null;
}

export async function listPrincipals(opts: {
  tenantId?: string;
  entityKind?: string;
  limit?: number;
  offset?: number;
}): Promise<{ items: Principal[]; total: number }> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  if (opts.tenantId) {
    conditions.push(`owner_tenant_id = $${idx++}`);
    params.push(opts.tenantId);
  }
  if (opts.entityKind) {
    conditions.push(`entity_kind = $${idx++}`);
    params.push(opts.entityKind);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = opts.limit || 50;
  const offset = opts.offset || 0;

  const countResult = await pool.query(`SELECT count(*) FROM principals ${where}`, params);
  const total = parseInt(countResult.rows[0].count, 10);

  const { rows } = await pool.query(
    `SELECT * FROM principals ${where} ORDER BY first_seen_at DESC LIMIT $${idx++} OFFSET $${idx++}`,
    [...params, limit, offset]
  );

  return { items: rows, total };
}

export async function addKey(
  principalId: string,
  keyId: string,
  publicKeyRaw: Buffer,
  publicKeyJwk: Record<string, unknown>,
  keyHash: string
): Promise<PrincipalKey> {
  const { rows } = await pool.query(
    `INSERT INTO principal_keys (principal_id, key_id, public_key_raw, public_key_jwk, key_hash)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [principalId, keyId, publicKeyRaw, publicKeyJwk, keyHash]
  );
  return rows[0];
}

export async function listKeys(principalId: string): Promise<PrincipalKey[]> {
  const { rows } = await pool.query(
    'SELECT * FROM principal_keys WHERE principal_id = $1 ORDER BY valid_from',
    [principalId]
  );
  return rows;
}

export async function getKeyByHash(keyHash: string): Promise<PrincipalKey | null> {
  const { rows } = await pool.query(
    'SELECT * FROM principal_keys WHERE key_hash = $1',
    [keyHash]
  );
  return rows[0] || null;
}

export async function createIssuer(
  principalId: string,
  trustWeight?: number
): Promise<void> {
  if (trustWeight !== undefined) {
    await pool.query(
      `INSERT INTO issuers (principal_id, trust_weight)
       VALUES ($1, $2)
       ON CONFLICT (principal_id) DO UPDATE SET trust_weight = EXCLUDED.trust_weight`,
      [principalId, trustWeight]
    );
  } else {
    await pool.query(
      `INSERT INTO issuers (principal_id)
       VALUES ($1)
       ON CONFLICT (principal_id) DO NOTHING`,
      [principalId]
    );
  }
}

export async function updatePrincipal(id: string, fields: { entity_kind?: string }): Promise<void> {
  const sets: string[] = [];
  const params: unknown[] = [];
  let idx = 1;
  if (fields.entity_kind) {
    sets.push(`entity_kind = $${idx++}`);
    params.push(fields.entity_kind);
  }
  if (sets.length === 0) return;
  params.push(id);
  await pool.query(`UPDATE principals SET ${sets.join(', ')} WHERE id = $${idx}`, params);
}

export interface Issuer {
  principal_id: string;
  trust_weight: string;
  is_bootstrap: boolean;
  verified_at: Date | null;
  created_at: Date;
}

export async function getIssuer(principalId: string): Promise<Issuer | null> {
  const { rows } = await pool.query(
    'SELECT * FROM issuers WHERE principal_id = $1',
    [principalId]
  );
  return rows[0] || null;
}

export async function getKeyByKid(principalId: string, keyId: string): Promise<PrincipalKey | null> {
  const { rows } = await pool.query(
    `SELECT * FROM principal_keys
     WHERE principal_id = $1 AND key_id = $2 AND revoked_at IS NULL`,
    [principalId, keyId]
  );
  return rows[0] || null;
}

export async function getActiveKeysAt(principalId: string, iat: Date): Promise<PrincipalKey[]> {
  const { rows } = await pool.query(
    `SELECT * FROM principal_keys
     WHERE principal_id = $1
       AND revoked_at IS NULL
       AND valid_from <= $2
       AND (valid_until IS NULL OR valid_until >= $2)
     ORDER BY valid_from`,
    [principalId, iat]
  );
  return rows;
}
