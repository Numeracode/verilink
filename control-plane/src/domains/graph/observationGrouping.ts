// control-plane/src/domains/graph/observationGrouping.ts
// Collapse split-visibility attestations by observation_id (design §4.5).

export interface GroupableAttestation {
  id: string;
  issuer_id: string;
  subject_id: string;
  observation_id: string | null;
  visibility: 'participants' | 'public' | string;
  issued_at: Date;
  trust_delta: number;
  attestation_type: string;
  expires_at: Date | null;
}

/** participants is more restrictive than public. */
function visibilityRank(v: string): number {
  return v === 'participants' ? 2 : 1;
}

/**
 * Non-empty observation_id → one edge per (issuer, subject, observation_id).
 * Null/empty → one edge per attestation.id (never collapsed).
 */
export function groupAttestationsForScoring<T extends GroupableAttestation>(rows: T[]): T[] {
  const unpaired: T[] = [];
  const groups = new Map<string, T[]>();

  for (const row of rows) {
    const oid = row.observation_id?.trim() || '';
    if (!oid) {
      unpaired.push(row);
      continue;
    }
    const key = `${row.issuer_id}\0${row.subject_id}\0${oid}`;
    const list = groups.get(key);
    if (list) list.push(row);
    else groups.set(key, [row]);
  }

  const representatives: T[] = [...unpaired];
  for (const list of groups.values()) {
    list.sort((a, b) => {
      const vr = visibilityRank(b.visibility) - visibilityRank(a.visibility);
      if (vr !== 0) return vr;
      return b.issued_at.getTime() - a.issued_at.getTime();
    });
    representatives.push(list[0]);
  }
  return representatives;
}
