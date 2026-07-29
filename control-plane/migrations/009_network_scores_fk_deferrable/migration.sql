-- Make network_scores.principal_id FK deferrable so score upserts and
-- principal lifecycle can commit in one transaction (design §5).

ALTER TABLE network_scores
  DROP CONSTRAINT network_scores_principal_id_fkey;

ALTER TABLE network_scores
  ADD CONSTRAINT network_scores_principal_id_fkey
  FOREIGN KEY (principal_id) REFERENCES principals(id) ON DELETE CASCADE
  DEFERRABLE INITIALLY DEFERRED;
