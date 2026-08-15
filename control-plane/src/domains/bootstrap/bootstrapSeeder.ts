// control-plane/src/domains/bootstrap/bootstrapSeeder.ts

import { createHash } from 'node:crypto';
import type pg from 'pg';
import { withTransaction } from '../../db/transaction.js';
import { SEED_ISSUERS, type SeedIssuerEntry } from './seedManifest.js';
import { seedBootstrapAttestations } from './seedAttestations.js';

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
 *
 * Conflict detection: if a principal or key already exists with identity
 * fields that differ from the manifest (entity_kind, name, public_key_raw,
 * key_hash), the seed aborts the whole transaction instead of silently
 * continuing — a mismatched root must never be half-seeded.
 */
async function upsertSeedIssuer(client: pg.PoolClient, entry: SeedIssuerEntry): Promise<void> {
  const keyHash = keyHashForX(entry.publicKeyX);
  const raw = Buffer.from(entry.publicKeyX, 'base64url');

  const { rows: existingPrincipal } = await client.query(
    'SELECT entity_kind, name FROM principals WHERE id = $1',
    [entry.id],
  );
  if (existingPrincipal.length > 0) {
    const p = existingPrincipal[0];
    if (p.entity_kind !== entry.entityKind || p.name !== entry.name) {
      throw new Error(
        'bootstrap seed conflict: principal ' + entry.id + ' exists with entity_kind=' + p.entity_kind + ' name=' + p.name + ', ' +
          'manifest expects entity_kind=' + entry.entityKind + ' name=' + entry.name,
      );
    }
  }

  const { rows: existingKey } = await client.query(
    'SELECT public_key_raw, key_hash FROM principal_keys WHERE principal_id = $1 AND key_id = $2',
    [entry.id, entry.keyId],
  );
  if (existingKey.length > 0) {
    const k = existingKey[0];
    const rawMatches = Buffer.isBuffer(k.public_key_raw)
      ? k.public_key_raw.equals(raw)
      : Buffer.from(k.public_key_raw).equals(raw);
    if (!rawMatches || k.key_hash !== keyHash) {
      throw new Error(
        'bootstrap seed conflict: key ' + entry.id + '/' + entry.keyId + ' exists with a different public key',
      );
    }
  }

  await client.query(
    'INSERT INTO principals (id, entity_kind, owner_tenant_id, name, metadata) VALUES ($1, $2, NULL, $3, $4) ON CONFLICT (id) DO NOTHING',
    [entry.id, entry.entityKind, entry.name, JSON.stringify({ bootstrap_seed: true, note: entry.note })],
  );
  await client.query(
    'INSERT INTO issuers (principal_id) VALUES ($1) ON CONFLICT (principal_id) DO NOTHING',
    [entry.id],
  );
  await client.query(
    'INSERT INTO principal_keys (principal_id, key_id, public_key_raw, public_key_jwk, key_hash, control_verified_at, valid_from) VALUES ($1, $2, $3, $4, $5, NOW() - INTERVAL \'1 hour\', NOW() - INTERVAL \'1 hour\') ON CONFLICT (principal_id, key_id) DO NOTHING',
    [entry.id, entry.keyId, raw, JSON.stringify(publicKeyJwk(entry.publicKeyX)), keyHash],
  );
  await client.query(
    'INSERT INTO bootstrap_issuers (principal_id, name, current_weight) VALUES ($1, $2, 1.0) ON CONFLICT (principal_id) DO NOTHING',
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
    'UPDATE issuers i SET is_bootstrap = EXISTS (SELECT 1 FROM bootstrap_issuers b WHERE b.principal_id = i.principal_id AND b.removed_from_registry_at IS NULL AND b.current_weight > 0)',
  );
}

/** Derive is_bootstrap for a single issuer (PATCH path). */
export async function deriveIsBootstrapForIssuer(
  client: pg.PoolClient,
  principalId: string,
): Promise<void> {
  await client.query(
    'UPDATE issuers i SET is_bootstrap = EXISTS (SELECT 1 FROM bootstrap_issuers b WHERE b.principal_id = i.principal_id AND b.removed_from_registry_at IS NULL AND b.current_weight > 0) WHERE i.principal_id = $1',
    [principalId],
  );
}

export interface SeedResult {
  issuers: number;
  roots: number;
  attestations: number;
  subjects: number;
}

/**
 * Idempotent bootstrap registry seed (Plan 10 PR A + PR B). One transaction for
 * the whole run: registry upsert, is_bootstrap derivation, and seed attestation
 * insertion. A partial seed can never leave a half-created root. Reruns are
 * no-ops over the manifest (insert-only) and re-derive is_bootstrap.
 *
 * Seed attestations (PR B) are skipped when BOOTSTRAP_SEED_PRIVATE_KEY_JWK is
 * not set — the registry seed still succeeds.
 */
export async function seedBootstrapRegistry(): Promise<SeedResult> {
  return withTransaction(async (client) => {
    for (const entry of SEED_ISSUERS) {
      await upsertSeedIssuer(client, entry);
    }
    await deriveIsBootstrap(client);

    let attestations = 0;
    let subjects = 0;
    if (process.env.BOOTSTRAP_SEED_PRIVATE_KEY_JWK) {
      const att = await seedBootstrapAttestations(client);
      attestations = att.attestations;
      subjects = att.subjects;
    }

    const { rows } = await client.query<{ issuers: string; roots: string }>(
      'SELECT (SELECT count(*) FROM issuers WHERE is_bootstrap)::text AS issuers, (SELECT count(*) FROM bootstrap_issuers)::text AS roots',
    );
    return {
      issuers: parseInt(rows[0].issuers, 10),
      roots: parseInt(rows[0].roots, 10),
      attestations,
      subjects,
    };
  });
}
