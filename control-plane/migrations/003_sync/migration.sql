-- control-plane/migrations/003_sync/migration.sql

-- Sync event log (unified, transactionally safe)
CREATE TABLE sync_events (
  sync_version    BIGINT PRIMARY KEY,               -- allocated by the locked allocator, in-commit-order
  event_type      TEXT NOT NULL CHECK (event_type IN (
    'score.upsert', 'score.delete', 'key.upsert', 'key.revoke', 'policy.replace'
  )),
  principal_id    TEXT,
  tenant_id       UUID,
  payload         JSONB NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_sync_events_tenant ON sync_events (tenant_id) WHERE tenant_id IS NOT NULL;

-- Bootstrap registry (issuers only — roots are always issuers)
CREATE TABLE bootstrap_issuers (
  principal_id    TEXT PRIMARY KEY REFERENCES issuers(principal_id),
  name            TEXT NOT NULL,
  current_weight  NUMERIC(3,2) NOT NULL DEFAULT 1.0, -- written through to Root.weight
  seeded_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  de_emphasized_at TIMESTAMPTZ,
  de_emphasis_reason TEXT,
  approved_by     UUID
);
