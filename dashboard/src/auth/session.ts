const TOKEN_KEY = 'verilink.dashboard.token';
const TENANT_KEY = 'verilink.dashboard.tenantId';

export function getStoredToken(): string | null {
  return sessionStorage.getItem(TOKEN_KEY);
}

export function setStoredToken(token: string | null): void {
  if (token) sessionStorage.setItem(TOKEN_KEY, token);
  else sessionStorage.removeItem(TOKEN_KEY);
}

export function getStoredTenantId(): string | null {
  return sessionStorage.getItem(TENANT_KEY);
}

export function setStoredTenantId(tenantId: string | null): void {
  if (tenantId) sessionStorage.setItem(TENANT_KEY, tenantId);
  else sessionStorage.removeItem(TENANT_KEY);
}
