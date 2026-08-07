import { apiFetch, ApiError } from './client';

interface Envelope<T> {
  ok: true;
  data: T;
}

export interface OwnedPrincipal {
  id: string;
  entity_kind: string;
  name: string | null;
  owner_tenant_id: string | null;
  assurance_level: string;
  first_seen_at: string;
  last_seen_at: string;
  status: string;
}

export interface PrincipalKey {
  principal_id: string;
  key_id: string;
  key_hash: string;
  control_verified_at: string | null;
  valid_from: string;
  valid_until: string | null;
  revoked_at: string | null;
}

export interface PrincipalDetail {
  id: string;
  entity_kind: string;
  name: string | null;
  owner_tenant_id: string | null;
  status: string;
  issuer: {
    trust_weight: number;
    verified_at: string | null;
    is_bootstrap: boolean;
  } | null;
}

export interface AttestationRow {
  id: string;
  issuer_id: string;
  subject_id: string;
  attestation_type: string;
  trust_delta: number;
  visibility: string;
  issued_at: string;
  received_at: string;
}

export interface ScoreHistoryPoint {
  score: number;
  blacklisted: boolean;
  score_reason: string;
  computed_at: string;
  sync_version: string;
}

export interface ScoreHistory {
  current: { score: number; blacklisted: boolean; score_reason: string; computed_at: string } | null;
  items: ScoreHistoryPoint[];
}

export async function fetchOwnedPrincipals(): Promise<OwnedPrincipal[]> {
  const res = await apiFetch<Envelope<{ items: OwnedPrincipal[]; total: number }>>('/v1/principals');
  return res.data.items;
}

export async function fetchPrincipalDetail(id: string): Promise<PrincipalDetail> {
  const res = await apiFetch<Envelope<PrincipalDetail>>(`/v1/principals/${encodeURIComponent(id)}`);
  return res.data;
}

export async function fetchPrincipalKeys(id: string): Promise<PrincipalKey[]> {
  const res = await apiFetch<Envelope<PrincipalKey[]>>(`/v1/principals/${encodeURIComponent(id)}/keys`);
  return res.data;
}

export async function fetchAttestations(
  id: string,
  direction: 'in' | 'out',
  limit = 25
): Promise<AttestationRow[]> {
  const param = direction === 'in' ? 'subject_id' : 'issuer_id';
  const res = await apiFetch<Envelope<{ items: AttestationRow[]; total: number }>>(
    `/v1/attestations?${param}=${encodeURIComponent(id)}&limit=${limit}`
  );
  return res.data.items;
}

export async function fetchScoreHistory(id: string): Promise<ScoreHistory> {
  const res = await apiFetch<Envelope<ScoreHistory>>(
    `/v1/scores/${encodeURIComponent(id)}/history`
  );
  return res.data;
}

/** Returns null when the resource 404s (e.g. no score history yet). */
export async function safeScoreHistory(id: string): Promise<ScoreHistory | null> {
  try {
    return await fetchScoreHistory(id);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
}
