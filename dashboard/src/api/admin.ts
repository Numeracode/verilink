import { apiFetch, ApiError } from './client';

interface Envelope<T> {
  ok: true;
  data: T;
}

export interface TenantRow {
  id: string;
  slug: string;
  name: string;
  plan: string;
  status: string;
  created_at: string;
}

export interface BootstrapIssuer {
  principal_id: string;
  name: string;
  current_weight: number;
  de_emphasis_reason: string | null;
  de_emphasized_at: string | null;
  approved_by: string | null;
  seeded_at: string;
  trust_weight: number;
  verified_at: string | null;
}

export interface UnverifiedIssuer {
  principal_id: string;
  name: string | null;
  entity_kind: string;
  trust_weight: number;
  is_bootstrap: boolean;
  created_at: string;
}

export async function fetchTenants(): Promise<TenantRow[]> {
  const res = await apiFetch<Envelope<{ items: TenantRow[] }>>('/v1/tenants');
  return res.data.items;
}

export async function fetchBootstrapIssuers(): Promise<BootstrapIssuer[]> {
  const res = await apiFetch<Envelope<{ items: BootstrapIssuer[] }>>('/v1/admin/bootstrap-issuers');
  return res.data.items;
}

export async function updateBootstrapIssuer(
  principalId: string,
  patch: { current_weight?: number; de_emphasis_reason?: string | null }
): Promise<BootstrapIssuer> {
  const res = await apiFetch<Envelope<{ issuer: BootstrapIssuer }>>(
    '/v1/admin/bootstrap-issuers',
    { method: 'PATCH', body: JSON.stringify({ principal_id: principalId, ...patch }) }
  );
  return res.data.issuer;
}

export async function fetchUnverifiedIssuers(): Promise<UnverifiedIssuer[]> {
  const res = await apiFetch<Envelope<{ items: UnverifiedIssuer[] }>>('/v1/admin/issuers/unverified');
  return res.data.items;
}

/** Open the Stripe customer portal for the caller tenant; returns a URL. */
export async function createPortalSession(): Promise<string | null> {
  try {
    const res = await apiFetch<Envelope<{ url: string }>>('/v1/billing/portal-session', {
      method: 'POST',
      body: '{}',
    });
    return res.data.url;
  } catch (err) {
    // No subscription yet → no portal. Surface as "no subscription" upstream.
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
}


export interface ContributionSplit {
  bootstrap_weighted: number;
  organic_weighted: number;
  organic_pct: number;
  independent_organic_issuers: number;
  window_days: number;
  window_continuous: boolean;
}

export interface CounterfactualDrop {
  principal_id: string;
  current_score: number;
  counterfactual_score: number;
  serving_tenant_id: string | null;
  tenant_threshold: number;
  drops_below_threshold: boolean;
}

export interface CounterfactualReport {
  root_id: string;
  target_weight: number;
  graph_version: number;
  drops: CounterfactualDrop[];
  worst_case_drop: number;
}

export interface DeEmphasisCandidate {
  principal_id: string;
  name: string;
  current_weight: number;
  contribution: ContributionSplit;
  ready: boolean;
  not_ready_reasons: string[];
  counterfactual: CounterfactualReport | null;
}

export interface DeEmphasisResult {
  generated_at: string;
  window_days: number;
  contribution: ContributionSplit;
  candidates: DeEmphasisCandidate[];
}

export async function fetchDeEmphasis(): Promise<DeEmphasisResult> {
  const res = await apiFetch<Envelope<DeEmphasisResult>>('/v1/admin/bootstrap/de-emphasis');
  return res.data;
}
