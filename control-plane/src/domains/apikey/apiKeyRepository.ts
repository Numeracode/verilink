// control-plane/src/domains/apikey/apiKeyRepository.ts
import { createHmac, randomBytes } from 'node:crypto';
import { pool } from '../../db/client.js';
import { config } from '../../config.js';
import { AppError, CODES } from '../../shared/errors/AppError.js';

export interface ApiKeyMeta {
  id: string;
  tenant_id: string;
  key_prefix: string;
  scopes: string[];
  last_used_at: Date | null;
  created_at: Date;
}

/** The full secret is returned exactly once, at creation time. */
export interface CreatedApiKey extends ApiKeyMeta {
  secret: string;
}

const SCHEMA_KEY = 'vrl_';

function hashApiKey(key: string): string {
  return createHmac('sha256', config.apiKey.hmacSecret || '')
    .update(key)
    .digest('hex');
}

export function generateApiKeySecret(): string {
  return `${SCHEMA_KEY}${randomBytes(32).toString('hex')}`;
}

/** List the caller tenant's API keys (never the hash). */
export async function listApiKeys(tenantId: string): Promise<ApiKeyMeta[]> {
  const { rows } = await pool.query(
    `SELECT id, tenant_id, key_prefix, scopes, last_used_at, created_at
     FROM api_keys
     WHERE tenant_id = $1 AND revoked_at IS NULL
     ORDER BY created_at DESC`,
    [tenantId]
  );
  return rows as ApiKeyMeta[];
}

export async function createApiKey(tenantId: string, scopes: string[]): Promise<CreatedApiKey> {
  const secret = generateApiKeySecret();
  const prefix = secret.slice(0, 7); // vrl_ + first 3 hex chars
  const hash = hashApiKey(secret);

  const { rows } = await pool.query(
    `INSERT INTO api_keys (tenant_id, key_prefix, key_hash_hmac, scopes)
     VALUES ($1, $2, $3, $4)
     RETURNING id, tenant_id, key_prefix, scopes, last_used_at, created_at`,
    [tenantId, prefix, hash, scopes]
  );
  return { ...(rows[0] as ApiKeyMeta), secret };
}

/** Soft-revoke a tenant's key. 404 if not owned by the tenant (no info leak). */
export async function revokeApiKey(tenantId: string, keyId: string): Promise<void> {
  const { rowCount } = await pool.query(
    `UPDATE api_keys SET revoked_at = now()
     WHERE id = $1 AND tenant_id = $2 AND revoked_at IS NULL`,
    [keyId, tenantId]
  );
  if (rowCount === 0) {
    throw new AppError(CODES.NOT_FOUND, 'API key not found');
  }
}
