-- Validate constraints added as NOT VALID in 009–011, then finish swaps.
-- Runs in its own migration transaction so validation scans do not extend
-- the lock window of the ADD NOT VALID migrations.

-- network_scores FK: validate replacement, then drop + rename
ALTER TABLE network_scores
  VALIDATE CONSTRAINT network_scores_principal_id_fkey_v2;

ALTER TABLE network_scores
  DROP CONSTRAINT network_scores_principal_id_fkey;

ALTER TABLE network_scores
  RENAME CONSTRAINT network_scores_principal_id_fkey_v2 TO network_scores_principal_id_fkey;

-- weight bounds: validate replacements, then drop + rename
ALTER TABLE issuers VALIDATE CONSTRAINT issuers_trust_weight_check_v2;
ALTER TABLE issuers DROP CONSTRAINT issuers_trust_weight_check;
ALTER TABLE issuers RENAME CONSTRAINT issuers_trust_weight_check_v2 TO issuers_trust_weight_check;

ALTER TABLE bootstrap_issuers VALIDATE CONSTRAINT bootstrap_issuers_current_weight_check_v2;
ALTER TABLE bootstrap_issuers DROP CONSTRAINT bootstrap_issuers_current_weight_check;
ALTER TABLE bootstrap_issuers
  RENAME CONSTRAINT bootstrap_issuers_current_weight_check_v2 TO bootstrap_issuers_current_weight_check;

-- history entity_kind: validate NOT NULL check, SET NOT NULL, drop temp, validate kind check
ALTER TABLE network_score_history
  VALIDATE CONSTRAINT network_score_history_entity_kind_not_null;

ALTER TABLE network_score_history
  ALTER COLUMN entity_kind SET NOT NULL;

ALTER TABLE network_score_history
  DROP CONSTRAINT network_score_history_entity_kind_not_null;

ALTER TABLE network_score_history
  VALIDATE CONSTRAINT network_score_history_entity_kind_check;
