-- control-plane/migrations/004_tenancy/migration.sql

-- Tenants
CREATE TABLE tenants (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug         TEXT UNIQUE NOT NULL,
  name         TEXT NOT NULL,
  plan         TEXT NOT NULL DEFAULT 'free',
  status       TEXT NOT NULL DEFAULT 'active',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Global users
CREATE TABLE users (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email        CITEXT UNIQUE NOT NULL,
  oidc_issuer  TEXT NOT NULL,
  oidc_subject TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (oidc_issuer, oidc_subject)
);

-- Tenant memberships
CREATE TABLE tenant_memberships (
  user_id      UUID NOT NULL REFERENCES users(id),
  tenant_id    UUID NOT NULL REFERENCES tenants(id),
  role         TEXT NOT NULL DEFAULT 'member',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, tenant_id)
);

-- API keys — HMAC-SHA256. Format: vrl_ + exactly 64 lowercase hex.
CREATE TABLE api_keys (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id),
  key_prefix      TEXT NOT NULL,
  key_hash_hmac   TEXT NOT NULL,
  scopes          TEXT[] NOT NULL DEFAULT '{}',
  last_used_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at      TIMESTAMPTZ,
  UNIQUE (tenant_id, id)
);

-- Now add the FK from principals to tenants
ALTER TABLE principals
  ADD CONSTRAINT fk_principals_owner_tenant
  FOREIGN KEY (owner_tenant_id) REFERENCES tenants(id);

-- Now add the FK from bootstrap_issuers to users
ALTER TABLE bootstrap_issuers
  ADD CONSTRAINT fk_bootstrap_approved_by
  FOREIGN KEY (approved_by) REFERENCES users(id);
