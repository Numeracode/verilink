-- Retain entity_kind on score history so kind-only changes are auditable.
-- Validate a NOT NULL CHECK first so SET NOT NULL can skip a redundant scan.

ALTER TABLE network_score_history
  ADD COLUMN entity_kind TEXT;

UPDATE network_score_history h
SET entity_kind = s.entity_kind
FROM network_scores s
WHERE h.principal_id = s.principal_id
  AND h.entity_kind IS NULL;

UPDATE network_score_history h
SET entity_kind = p.entity_kind
FROM principals p
WHERE h.principal_id = p.id
  AND h.entity_kind IS NULL;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM network_score_history WHERE entity_kind IS NULL) THEN
    RAISE EXCEPTION
      'Cannot apply 011_network_score_history_entity_kind: history rows lack entity_kind and cannot be backfilled';
  END IF;
END $$;

ALTER TABLE network_score_history
  ADD CONSTRAINT network_score_history_entity_kind_not_null
  CHECK (entity_kind IS NOT NULL) NOT VALID;

ALTER TABLE network_score_history
  VALIDATE CONSTRAINT network_score_history_entity_kind_not_null;

ALTER TABLE network_score_history
  ALTER COLUMN entity_kind SET NOT NULL;

ALTER TABLE network_score_history
  DROP CONSTRAINT network_score_history_entity_kind_not_null;

ALTER TABLE network_score_history
  ADD CONSTRAINT network_score_history_entity_kind_check
  CHECK (entity_kind IN ('agent', 'issuer', 'both')) NOT VALID;

ALTER TABLE network_score_history
  VALIDATE CONSTRAINT network_score_history_entity_kind_check;
