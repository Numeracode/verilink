-- control-plane/migrations/006_audit/migration.sql

-- Subscriptions (Stripe)
CREATE TABLE subscriptions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id),
  stripe_customer_id   TEXT NOT NULL,
  stripe_subscription_id TEXT NOT NULL,
  plan            TEXT NOT NULL,
  status          TEXT NOT NULL,
  current_period_end TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Stripe webhook event dedup (global)
CREATE TABLE stripe_webhook_events (
  id              TEXT PRIMARY KEY,
  received_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at    TIMESTAMPTZ,
  payload         JSONB NOT NULL
);

-- Decision aggregates: per-minute rollup
CREATE TABLE decision_aggregates (
  id              BIGSERIAL PRIMARY KEY,
  tenant_id       UUID NOT NULL REFERENCES tenants(id),
  edge_node_id    UUID NOT NULL,
  bucket_minute   TIMESTAMPTZ NOT NULL,
  dimension_kind  TEXT NOT NULL CHECK (dimension_kind IN ('all', 'principal', 'fingerprint')),
  dimension_value TEXT NOT NULL,                    -- '' for 'all'; the principal_id or fingerprint otherwise
  action          TEXT NOT NULL CHECK (action IN ('allow', 'deny', 'passthrough')),
  count           INTEGER NOT NULL CHECK (count >= 0),
  UNIQUE (tenant_id, edge_node_id, bucket_minute, dimension_kind, dimension_value, action),
  FOREIGN KEY (tenant_id, edge_node_id) REFERENCES edge_nodes(tenant_id, id)
);

-- Decision samples: all denies + tunable % of allows/passthroughs
CREATE TABLE decision_samples (
  id              BIGSERIAL PRIMARY KEY,
  tenant_id       UUID NOT NULL REFERENCES tenants(id),
  edge_node_id    UUID NOT NULL,
  wal_seq         BIGINT NOT NULL,
  fingerprint     TEXT NOT NULL,
  principal_id    TEXT,
  score           INTEGER,
  blacklisted     BOOLEAN,
  score_reason    TEXT,
  action          TEXT NOT NULL CHECK (action IN ('allow', 'deny', 'passthrough')),
  decided_at      TIMESTAMPTZ NOT NULL,
  FOREIGN KEY (tenant_id, edge_node_id) REFERENCES edge_nodes(tenant_id, id),
  received_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (edge_node_id, wal_seq)
);

-- Batch receipt (idempotent delivery)
CREATE TABLE decision_batches (
  edge_node_id    UUID NOT NULL,
  batch_id        UUID NOT NULL,
  tenant_id       UUID NOT NULL REFERENCES tenants(id),
  first_wal_seq   BIGINT NOT NULL,
  last_wal_seq    BIGINT NOT NULL,
  payload_hash    TEXT NOT NULL,                    -- sha256(batch payload)
  received_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (edge_node_id, batch_id),
  CHECK (first_wal_seq <= last_wal_seq),
  FOREIGN KEY (tenant_id, edge_node_id) REFERENCES edge_nodes(tenant_id, id)
);

-- Audit log: administrative/state-change events only (low volume)
CREATE TABLE audit_log (
  id              BIGSERIAL PRIMARY KEY,
  tenant_id       UUID NOT NULL REFERENCES tenants(id),
  actor_type      TEXT NOT NULL,
  actor_id        TEXT,
  action          TEXT NOT NULL,
  resource        TEXT NOT NULL,
  resource_id     TEXT,
  metadata        JSONB DEFAULT '{}',
  ip              TEXT,
  user_agent      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
