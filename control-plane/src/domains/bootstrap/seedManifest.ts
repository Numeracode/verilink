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
 * - The VeriLink bootstrap issuer public key below is paired with the dev
 *   private key in `.env.dev-keys` (gitignored) or `BOOTSTRAP_SEED_PRIVATE_KEY_JWK`
 *   env var. No private key is stored in the repo.
 * - Only verified issuers are seeded as roots.
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

/** Seed agent subject: a principal attested by the VeriLink bootstrap issuer. */
export interface SeedAgentEntry {
  /** Fixed `vrl:p:<uuid>` identity. */
  id: string;
  name: string;
  entityKind: 'agent' | 'both';
  /** Short provenance note. */
  note: string;
  /** Attestation trust_delta (0–100, positive). */
  trustDelta: number;
  /** Attestation type (must be a non-negative_incident type). */
  attestationType: string;
  /** Canonical facts for the seed attestation. */
  facts: Record<string, unknown>;
}

export const BOOTSTRAP_KEY_ID = 'bootstrap-k1';

export const SEED_ISSUERS: readonly SeedIssuerEntry[] = [
  {
    id: 'vrl:p:11111111-1111-4111-8111-111111111111',
    name: 'VeriLink Bootstrap',
    entityKind: 'issuer',
    keyId: BOOTSTRAP_KEY_ID,
    publicKeyX: 'GOGFvz5XIo7ylOg7DQzOrxyg68ulDuNclIDTMQwhzSI',
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

/**
 * Seeded agent subjects (Plan 10 decision 5): cold-started via bootstrap-issuer
 * attestations. Each entry becomes a principal + subject of an attestation
 * from the VeriLink bootstrap issuer (SEED_ISSUERS[0]).
 */
export const SEED_AGENTS: readonly SeedAgentEntry[] = [
  {
    id: 'vrl:p:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    name: 'VeriLink Edge Agent',
    entityKind: 'agent',
    note: 'VeriLink built-in edge verification agent.',
    trustDelta: 20,
    attestationType: 'transaction_summary',
    facts: {
      start: '2026-01-01T00:00:00.000Z',
      end: '2026-08-01T00:00:00.000Z',
      success_count: 1000,
      failure_count: 0,
      dispute_count: 0,
    },
  },
  {
    id: 'vrl:p:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    name: 'Whimsy Assistant',
    entityKind: 'agent',
    note: 'Whimsy platform assistant agent.',
    trustDelta: 15,
    attestationType: 'transaction_summary',
    facts: {
      start: '2026-03-01T00:00:00.000Z',
      end: '2026-08-01T00:00:00.000Z',
      success_count: 500,
      failure_count: 2,
      dispute_count: 0,
    },
  },
];

export const SEED_ISSUER_IDS: readonly string[] = SEED_ISSUERS.map((e) => e.id);
