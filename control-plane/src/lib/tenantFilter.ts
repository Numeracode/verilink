export function resolveCallerTenantIds(user: {
  tenantIds?: string[];
  tenantId?: string | null;
  roles?: string[];
} | undefined): string[] {
  if (!user) return [];
  const tenantIds = user.tenantIds || (user.tenantId ? [user.tenantId] : []);
  const roles = user.roles || [];
  if (roles.length > 0) {
    return tenantIds.filter((_, i) => roles[i] === 'staff' || roles[i] === 'admin');
  }
  return tenantIds;
}