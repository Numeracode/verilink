// control-plane/src/domains/tenant/tenantRepository.ts
import { pool } from '../../db/client.js';

export interface TenantRow {
  id: string;
  slug: string;
  name: string;
  plan: string;
  status: string;
  created_at: Date;
}

/** All tenants (platform staff). */
export async function listTenants(): Promise<TenantRow[]> {
  const { rows } = await pool.query(
    `SELECT id, slug, name, plan, status, created_at FROM tenants ORDER BY created_at DESC`
  );
  return rows as TenantRow[];
}

/** Tenants the given user is a member of. */
export async function listTenantsForUser(userId: string): Promise<TenantRow[]> {
  const { rows } = await pool.query(
    `SELECT t.id, t.slug, t.name, t.plan, t.status, t.created_at
     FROM tenants t
     JOIN tenant_memberships m ON m.tenant_id = t.id
     WHERE m.user_id = $1
     ORDER BY t.created_at DESC`,
    [userId]
  );
  return rows as TenantRow[];
}


/** A single tenant by id (API-key callers see their own tenant). */
export async function getTenantById(id: string): Promise<TenantRow | null> {
  const { rows } = await pool.query(
    `SELECT id, slug, name, plan, status, created_at FROM tenants WHERE id = $1`,
    [id]
  );
  return (rows[0] as TenantRow | undefined) ?? null;
}
