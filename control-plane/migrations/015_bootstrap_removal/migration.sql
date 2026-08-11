-- control-plane/migrations/015_bootstrap_removal/migration.sql

-- Plan 10 PR A: explicit removal state for bootstrap issuers so a seed rerun
-- (insert-only manifest) never reinstates an issuer de-emphasized/removed by
-- staff, and is_bootstrap derivation can exclude removed rows.
ALTER TABLE bootstrap_issuers
  ADD COLUMN removed_from_registry_at TIMESTAMPTZ;

-- Recalculate is_bootstrap for existing rows under the new semantics so the
-- derived flag is correct immediately (no reliance on a later seed/PATCH):
-- true exactly for registry members that are not removed and still carry a
-- root weight > 0. Mirrors deriveIsBootstrap in bootstrapSeeder.ts.
UPDATE issuers i
SET is_bootstrap = EXISTS (
  SELECT 1 FROM bootstrap_issuers b
  WHERE b.principal_id = i.principal_id
    AND b.removed_from_registry_at IS NULL
    AND b.current_weight > 0
);
