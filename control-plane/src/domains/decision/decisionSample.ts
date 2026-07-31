import { createHash } from 'node:crypto';

export interface DecisionWire {
  wal_seq: number;
  fingerprint: string;
  principal_id?: string | null;
  score?: number | null;
  blacklisted?: boolean | null;
  score_reason?: string | null;
  action: 'allow' | 'deny' | 'passthrough';
  decided_at: string;
}

const RFC3339_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/** Require RFC3339 with an explicit timezone (Z or ±HH:MM). */
export function assertRFC3339(decidedAt: string): void {
  if (!RFC3339_RE.test(decidedAt) || Number.isNaN(Date.parse(decidedAt))) {
    throw new Error('decided_at must be RFC3339 with timezone');
  }
}

/**
 * Canonical decision JSON matching Go edgeverifier decisionWire (fixed key order,
 * no omitempty). Used for payload_hash verification across languages.
 */
export function canonicalizeDecisionsJSON(decisions: DecisionWire[]): string {
  return JSON.stringify(
    decisions.map((d) => ({
      wal_seq: d.wal_seq,
      fingerprint: d.fingerprint,
      principal_id: d.principal_id ?? '',
      score: d.score ?? 0,
      blacklisted: d.blacklisted ?? false,
      score_reason: d.score_reason ?? '',
      action: d.action,
      decided_at: d.decided_at,
    }))
  );
}

export function sha256Hex(payload: string): string {
  return createHash('sha256').update(payload).digest('hex');
}

/** Deterministic UUID shaped like Go fmt `%x-%x-%x-%x-%x` over the first 16 hash bytes. */
export function batchIDFromPayloadHash(payloadHash: string): string {
  const h = payloadHash.toLowerCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/**
 * Deterministic sample gate: all denies; allows/passthroughs at allow_sample_rate.
 * Uses decided_at ms so sampling stays stable across WAL seq resets/compaction.
 */
export function shouldSample(action: string, decidedAt: string, rate: number): boolean {
  if (action === 'deny') return true;
  if (rate <= 0) return false;
  if (rate >= 1) return true;
  const ms = Date.parse(decidedAt);
  if (Number.isNaN(ms)) return false;
  const bucket = ((ms % 10000) + 10000) % 10000;
  return bucket / 10000 < rate;
}
