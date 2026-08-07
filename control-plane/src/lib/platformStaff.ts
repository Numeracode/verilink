// control-plane/src/lib/platformStaff.ts
/**
 * Platform-staff check that unifies OIDC platform staff (`isStaff`) with
 * `admin:read` API keys, mirroring `requireStaff` so non-requireStaff routes
 * (e.g. /v1/tenants) treat both as staff-level.
 */
export function isPlatformStaff(user: {
  isStaff?: boolean;
  type?: string;
  scopes?: string[];
} | undefined): boolean {
  if (!user) return false;
  if (user.isStaff) return true;
  if (user.type === 'apikey' && (user.scopes || []).includes('admin:read')) return true;
  return false;
}
