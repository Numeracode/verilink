import pg from 'pg';
import crypto from 'node:crypto';
import { createHmac } from 'node:crypto';
import { SignJWT } from 'jose';

export interface SeededTenant {
  id: string;
  slug: string;
}

export interface SeededIssuer {
  id: string;
  keyId: string;
  publicKeyRaw: Buffer;
  privateKey: crypto.KeyObject;
}

export async function seedTenant(pool: pg.Pool, slug: string): Promise<SeededTenant> {
  const { rows } = await pool.query(
    `INSERT INTO tenants (slug, name, status)
     VALUES ($1, $2, 'active')
     RETURNING id, slug`,
    [slug, slug]
  );
  return { id: rows[0].id as string, slug: rows[0].slug as string };
}

export async function seedIssuer(pool: pg.Pool, tenantId: string): Promise<SeededIssuer> {
  const id = `vrl:p:${crypto.randomUUID()}`;
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const jwk = publicKey.export({ format: 'jwk' }) as crypto.JsonWebKey;
  const publicKeyRaw = Buffer.from(jwk.x as string, 'base64url');
  const keyHash = crypto.createHash('sha256').update(publicKeyRaw).digest('hex');
  const keyId = 'k1';

  await pool.query(
    `INSERT INTO principals (id, entity_kind, owner_tenant_id)
     VALUES ($1, 'issuer', $2)`,
    [id, tenantId]
  );
  await pool.query(`INSERT INTO issuers (principal_id) VALUES ($1)`, [id]);
  await pool.query(
    `INSERT INTO principal_keys (principal_id, key_id, public_key_raw, public_key_jwk, key_hash, valid_from)
     VALUES ($1, $2, $3, $4, $5, NOW() - INTERVAL '1 hour')`,
    [id, keyId, publicKeyRaw, jwk, keyHash]
  );

  return { id, keyId, publicKeyRaw, privateKey };
}

export async function seedSubject(pool: pg.Pool, tenantId: string): Promise<{ id: string }> {
  const id = `vrl:p:${crypto.randomUUID()}`;
  await pool.query(
    `INSERT INTO principals (id, entity_kind, owner_tenant_id)
     VALUES ($1, 'agent', $2)`,
    [id, tenantId]
  );
  return { id };
}

/** Creates a vrl_ API key (68 chars) with HMAC hash matching auth middleware. */
export async function seedApiKey(
  pool: pg.Pool,
  tenantId: string,
  scopes: string[]
): Promise<string> {
  const key = `vrl_${crypto.randomBytes(32).toString('hex')}`;
  const prefix = key.slice(0, 7);
  const secret = process.env.API_KEY_HMAC_SECRET || '';
  const hash = createHmac('sha256', secret).update(key).digest('hex');

  await pool.query(
    `INSERT INTO api_keys (tenant_id, key_prefix, key_hash_hmac, scopes)
     VALUES ($1, $2, $3, $4)`,
    [tenantId, prefix, hash, scopes]
  );
  return key;
}

export function authHeaders(apiKey: string): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}` };
}

export async function signAttestationToken(opts: {
  issuerId: string;
  subjectId: string;
  privateKey: crypto.KeyObject;
  keyId: string;
  visibility?: 'participants' | 'public';
  trustLevelDelta?: number;
  attestationType?: string;
  facts?: Record<string, unknown>;
}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const facts = opts.facts ?? {
    start: new Date(Date.now() - 3600_000).toISOString(),
    end: new Date().toISOString(),
    success_count: 1,
    failure_count: 0,
    dispute_count: 0,
  };

  return new SignJWT({
    vli: {
      type: opts.attestationType ?? 'transaction_summary',
      facts,
      trust_level_delta: opts.trustLevelDelta ?? 10,
      schema_version: '1',
      visibility: opts.visibility ?? 'participants',
    },
  })
    .setProtectedHeader({ alg: 'EdDSA', kid: opts.keyId })
    .setIssuer(opts.issuerId)
    .setSubject(opts.subjectId)
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .setJti(crypto.randomUUID())
    .sign(opts.privateKey);
}
