-- control-plane/migrations/008_platform_role/migration.sql

-- Platform-level role for global staff/admin privileges.
-- Tenant-scoped roles (tenant_memberships.role) are NOT global.
-- Only users.platform_role = 'staff' or 'admin' bypasses tenant
-- visibility filters in cross-tenant queries.
ALTER TABLE users ADD COLUMN IF NOT EXISTS platform_role TEXT NOT NULL DEFAULT 'member';