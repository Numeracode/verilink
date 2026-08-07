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
