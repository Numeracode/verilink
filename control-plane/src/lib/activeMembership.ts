// control-plane/src/lib/activeMembership.ts
import { AppError, CODES } from '../shared/errors/AppError.js';

export interface Membership {
  tenant_id: string;
  role: string;
}

/**
 * Plan 9 Decision 4: the dashboard SPA sends `X-Tenant-Id` to choose the
 * active tenant. When present it must match one of the user's memberships
 * (403 otherwise). When absent, fall back to the first membership
 * (single-tenant convenience). No memberships → no active tenant.
 */
export function selectActiveMembership(
  memberships: Membership[],
  requestedTenantId: string | undefined
): { tenantId: string | null; role: string } {
  if (requestedTenantId) {
    const match = memberships.find((m) => m.tenant_id === requestedTenantId);
    if (!match) {
      throw new AppError(
        CODES.FORBIDDEN,
        'X-Tenant-Id does not match any tenant membership of this user'
      );
    }
    return { tenantId: match.tenant_id, role: match.role };
  }
  return {
    tenantId: memberships[0]?.tenant_id ?? null,
    role: memberships[0]?.role ?? 'member',
  };
}
