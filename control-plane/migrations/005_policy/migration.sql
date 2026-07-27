-- control-plane/migrations/005_policy/migration.sql

-- Policies: per-tenant threshold + actions
CREATE TABLE policies (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                UUID NOT NULL REFERENCES tenants(id),
  name                     TEXT NOT NULL,
  threshold                INTEGER NOT NULL DEFAULT 50,
  below_threshold_action   TEXT NOT NULL DEFAULT 'deny' CHECK (below_threshold_action IN ('allow', 'deny')),
  unsigned_action          TEXT NOT NULL DEFAULT 'passthrough' CHECK (unsigned_action IN ('passthrough', 'deny')),
  allow_fingerprints       TEXT[] DEFAULT '{}',
  deny_fingerprints        TEXT[] DEFAULT '{}',
  fail_open_expired        BOOLEAN NOT NULL DEFAULT false,
  no_drop_decisions        BOOLEAN NOT NULL DEFAULT false,
  max_snapshot_age_seconds INTEGER NOT NULL DEFAULT 300 CHECK (max_snapshot_age_seconds >= 0),
  allow_sample_rate        NUMERIC(4,3) NOT NULL DEFAULT 0.010 CHECK (allow_sample_rate >= 0 AND allow_sample_rate <= 1),
  is_active                BOOLEAN NOT NULL DEFAULT true,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);

-- One active policy per tenant (partial unique index)
CREATE UNIQUE INDEX active_policy_per_tenant ON policies (tenant_id) WHERE is_active;

-- Edge nodes
CREATE TABLE edge_nodes (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id),
  name            TEXT NOT NULL,
  api_key_id      UUID,
  last_seen_at    TIMESTAMPTZ,
  last_sync_version BIGINT,
  status          TEXT NOT NULL DEFAULT 'unknown',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, api_key_id) REFERENCES api_keys(tenant_id, id)
);

-- Sync cursors
CREATE TABLE sync_cursors (
  tenant_id       UUID NOT NULL,
  edge_node_id    UUID NOT NULL,
  last_cursor     BIGINT NOT NULL DEFAULT 0,
  last_sync_at    TIMESTAMPTZ,
  snapshot_hash   TEXT,
  PRIMARY KEY (tenant_id, edge_node_id),
  FOREIGN KEY (tenant_id, edge_node_id) REFERENCES edge_nodes(tenant_id, id)
);
