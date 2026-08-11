// control-plane/src/domains/bootstrap/seedManifest.ts

/**
 * Curated root-of-truth bootstrap registry (Plan 10, design §13 step 14 / §2.3).
 *
 * Rules (plan decisions 1–2, 5):
 * - Every seeded principal has a fixed, immutable id (`vrl:p:<fixed-uuid>`).
 * - Every seeded issuer has exactly one key, `key_id="bootstrap-k1"`, whose
 *   public key is committed here; `key_hash` is derived (sha256 of raw key).
 *   The manifest never mutates: reruns are insert-only.
 * - Mutable registry state (`current_weight`, de-emphasis columns) is never
 *   touched by the seeder; staff PATCH is the only writer.
 * - Public keys below are static Ed25519 JWK `x` values. No private key is
 *   stored in the repo. Seed attestation signing (PR B) needs the bootstrap
 *   issuer's private key from ops (gitignored dev key / env), NOT the repo.
 * - Only verified issuers are seeded as roots. Placeholder entries with
 *   unverified public keys are intentionally NOT in the registry (CodeRabbit
 *   review, PR #32): a root must be a real, verified issuer.
 */

export interface SeedIssuerEntry {
  /** Fixed `vrl:p:<uuid>` identity. */
  id: string;
  name: string;
  entityKind: 'issuer' | 'both';
  keyId: string;
  /** Ed25519 public key, base64url `x` (JWK form). */
  publicKeyX: string;
  /** Short provenance note surfaced to operators. */
  note: string;
}

export const BOOTSTRAP_KEY_ID = 'bootstrap-k1';

export const SEED_ISSUERS: readonly SeedIssuerEntry[] = [
  {
    id: 'vrl:p:11111111-1111-4111-8111-111111111111',
    name: 'VeriLink Bootstrap',
    entityKind: 'issuer',
    keyId: BOOTSTRAP_KEY_ID,
    publicKeyX: 'DMOam6VGDdUJkhONOZhfslFkA_L-lKONTIiyRgyVj-0',
    note: 'VeriLink-owned bootstrap root. Signs the seeded initial attestations (PR B).',
  },
  {
    id: 'vrl:p:22222222-2222-4222-8222-222222222222',
    name: 'Whimsy',
    entityKind: 'both',
    keyId: BOOTSTRAP_KEY_ID,
    publicKeyX: 'Mz1Sin-ts2l2P3S0DBhehW02chXdBIg64OHbl2KmMUE',
    note: 'First seeded issuer (design §2.3 / §6.3). Legacy behavioral@0 allowlist member.',
  },
];

export const SEED_ISSUER_IDS: readonly string[] = SEED_ISSUERS.map((e) => e.id);
