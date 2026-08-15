-- Plan 10 PR B: immutable bootstrap-origin provenance flag.
-- Distinguishes seed-origin attestations so organic-contribution math
-- (PR C) can exclude them even after the registry row is removed.

ALTER TABLE attestations
  ADD COLUMN bootstrap_origin BOOLEAN NOT NULL DEFAULT false;

-- Enforce immutability: bootstrap_origin can never be changed after INSERT.
CREATE OR REPLACE FUNCTION _vl_prevent_bootstrap_origin_update()
  RETURNS trigger AS $$
  BEGIN
    IF NEW.bootstrap_origin <> OLD.bootstrap_origin THEN
      RAISE EXCEPTION 'bootstrap_origin is immutable (Plan 10 decision 6)';
    END IF;
    RETURN NEW;
  END;
  $$ LANGUAGE plpgsql;

CREATE TRIGGER prevent_bootstrap_origin_update
  BEFORE UPDATE ON attestations
  FOR EACH ROW
  EXECUTE FUNCTION _vl_prevent_bootstrap_origin_update();

-- Partial index for filtering bootstrap-origin attestations.
-- Regular (non-CONCURRENTLY) is safe here: partial index on a boolean column
-- with few true rows; no meaningful lock contention risk.
CREATE INDEX idx_attestations_bootstrap_origin
  ON attestations (bootstrap_origin) WHERE bootstrap_origin = true;
