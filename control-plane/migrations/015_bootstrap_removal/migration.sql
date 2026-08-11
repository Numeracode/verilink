-- control-plane/migrations/015_bootstrap_removal/migration.sql

-- Plan 10 PR A: explicit removal state for bootstrap issuers so a seed rerun
-- (insert-only manifest) never reinstates an issuer de-emphasized/removed by
-- staff, and is_bootstrap derivation can exclude removed rows.
ALTER TABLE bootstrap_issuers
  ADD COLUMN removed_from_registry_at TIMESTAMPTZ;
