// control-plane/src/domains/bootstrap/bootstrapSeeder.ts

import { createHash } from 'node:crypto';
import type pg from 'pg';
import { withTransaction } from '../../db/transaction.js';
import { SEED_ISSUERS, type SeedIssuerEntry } from './seedManifest.js';

/**
 * sha256 hex of the raw Ed25519 public key. The raw key is the 32-byte
 * base64url-decoded JWK `x` (matches testutil/seedData and key-lookup ingest).
 */
export function keyHashForX(x: string): string {
  return createHash('sha256').update(Buffer.from(x, 'base64url')).digest('hex');
}

function publicKeyJwk(x: string): Record<string, unknown> {
  return { kty: 'OKP', crv: 'Ed25519', x, key_ops: ['verify'], ext: true };
}

/**
 * Upsert one seed issuer: principal + issuer row + key + registry row.
 * Insert-only for mutable registry columns so staff de-emphasis state
 * (current_weight, de_emphasized_at, de_emphasis_reason, approved_by,
 * removed_from_registry_at) survives reruns (plan decision 2).
 */
async function upsertSeedIssuer(client: pg.PoolClient, entry: SeedIssuerEntry): Promise<void> {
  const keyHash = keyHashForX(entry.publicKeyX);
  const raw = Buffer.from(entry.publicKeyX, 'base64url');

  await client.query(
    `INSERT INTO principals (id, entity_kind, owner_tenant_id, name, metadata)
     VALUES ($1, $2, NULL, $3, $4)
     ON CONFLICT (id) DO NOTHING`,
    [entry.id, entry.entityKind, entry.name, JSON.stringify({ bootstrap_seed: true, note: entry.note })],
  );
  await client.query(
    `INSERT INTO issuers (principal_id) VALUES ($1)
     ON CONFLICT (principal_id) DO NOTHING`,
    [entry.id],
  );
  await client.query(
    `INSERT INTO principal_keys
       (principal_id, key_id, public_key_raw, public_key_jwk, key_hash,
        control_verified_at, valid_from)
     VALUES ($1, $2, $3, $4, $5, NOW() - INTERVAL '1 hour', NOW() - INTERVAL '1 hour')
     ON CONFLICT (principal_id, key_id) DO NOTHING`,
    [entry.id, entry.keyId, raw, JSON.stringify(publicKeyJwk(entry.publicKeyX)), keyHash],
  );
  await client.query(
    `INSERT INTO bootstrap_issuers (principal_id, name, current_weight)
     VALUES ($1, $2, 1.0)
     ON CONFLICT (principal_id) DO NOTHING`,
    [entry.id, entry.name],
  );
}

/**
 * Derive issuers.is_bootstrap for every issuer from the bootstrap registry
 * (plan decision 3): true exactly for registry members that have not been
 * removed and still carry a root weight > 0.
 */
export async function deriveIsBootstrap(client: pg.PoolClient): Promise<void> {
  await client.query(
    `UPDATE issuers i
     SET is_bootstrap = EXISTS (
       SELECT 1 FROM bootstrap_issuers b
       WHERE b.principal_id = i.principal_id
         AND b.removed_from_registry_at IS NULL
         AND b.current_weight > 0
     )`,
  );
}

/** Derive is_bootstrap for a single issuer (PATCH path). */
export async function deriveIsBootstrapForIssuer(
  client: pg.PoolClient,
  principalId: string,
): Promise<void> {
  await client.query(
    `UPDATE issuers i
     SET is_bootstrap = EXISTS (
       SELECT 1 FROM bootstrap_issuers b
       WHERE b.principal_id = i.principal_id
         AND b.removed_from_registry_at IS NULL
         AND b.current_weight > 0
     )
     WHERE i.principal_id = $1`,
    [principalId],
  );
}

/**
 * Idempotent bootstrap registry seed (Plan 10 PR A). One transaction for the
 * whole run: a partial seed can never leave a half-created root. Reruns are
 * no-ops over the manifest (insert-only) and re-derive is_bootstrap.
 */
export async function seedBootstrapRegistry(): Promise<{
  issuers: number;
  roots: number;
}> {
  return withTransaction(async (client) => {
    for (const entry of SEED_ISSUERS) {
      await upsertSeedIssuer(client, entry);
    }
    await deriveIsBootstrap(client);
    const { rows } = await client.query<{ issuers: string; roots: string }>(
      `SELECT
         (SELECT count(*) FROM issuers WHERE is_bootstrap)::text AS issuers,
         (SELECT count(*) FROM bootstrap_issuers)::text AS roots`,
    );
    return {
      issuers: parseInt(rows[0].issuers, 10),
      roots: parseInt(rows[0].roots, 10),
    };
  });
}
