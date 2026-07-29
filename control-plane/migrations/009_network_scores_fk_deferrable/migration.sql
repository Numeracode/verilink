-- Make network_scores.principal_id FK deferrable so score upserts and
-- principal lifecycle can commit in one transaction (design §5).
-- Keep the live FK until the replacement is validated (no unconstrained window).

ALTER TABLE network_scores
  ADD CONSTRAINT network_scores_principal_id_fkey_v2
  FOREIGN KEY (principal_id) REFERENCES principals(id) ON DELETE CASCADE
  DEFERRABLE INITIALLY DEFERRED
  NOT VALID;

ALTER TABLE network_scores
  VALIDATE CONSTRAINT network_scores_principal_id_fkey_v2;

ALTER TABLE network_scores
  DROP CONSTRAINT network_scores_principal_id_fkey;

ALTER TABLE network_scores
  RENAME CONSTRAINT network_scores_principal_id_fkey_v2 TO network_scores_principal_id_fkey;
