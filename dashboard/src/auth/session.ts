/**
 * Auth session helpers.
 *
 * Bearer/API tokens stay in memory only (not Web Storage) so an XSS cannot
 * read them from sessionStorage/localStorage. Refresh clears the token —
 * acceptable for CI `apikey` mode until a CP HttpOnly session/BFF exists.
 * Tenant id is non-secret UI state and may live in sessionStorage.
 */

const TENANT_KEY = 'verilink.dashboard.tenantId';

let memoryToken: string | null = null;

export function getStoredToken(): string | null {
  return memoryToken;
}

export function setStoredToken(token: string | null): void {
  memoryToken = token;
}

export function getStoredTenantId(): string | null {
  return sessionStorage.getItem(TENANT_KEY);
}

export function setStoredTenantId(tenantId: string | null): void {
  if (tenantId) sessionStorage.setItem(TENANT_KEY, tenantId);
  else sessionStorage.removeItem(TENANT_KEY);
}
