-- Plan 10 PR B: immutable bootstrap-origin provenance flag.
-- Distinguishes seed-origin attestations so organic-contribution math
-- (PR C) can exclude them even after the registry row is removed.

ALTER TABLE attestations
  ADD COLUMN bootstrap_origin BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX idx_attestations_bootstrap_origin
  ON attestations (bootstrap_origin) WHERE bootstrap_origin = true;
