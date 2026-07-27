-- control-plane/migrations/007_legacy_mapping/migration.sql

-- Unique index on the legacy_did metadata key so that concurrent
-- first-ingest attempts for the same legacy subject cannot create
-- two different native principals. The first INSERT wins; the
-- second hits a unique violation and falls back to a SELECT.
CREATE UNIQUE INDEX IF NOT EXISTS principals_legacy_did_unique
  ON principals ((metadata->>'legacy_did'))
  WHERE metadata->>'legacy_did' IS NOT NULL;