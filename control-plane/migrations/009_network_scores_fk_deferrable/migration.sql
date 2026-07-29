-- Make network_scores.principal_id FK deferrable (design §5).
-- Add replacement as NOT VALID only — VALIDATE + swap happen in 012
-- (separate transaction / migration) to avoid a long blocking lock window.

ALTER TABLE network_scores
  ADD CONSTRAINT network_scores_principal_id_fkey_v2
  FOREIGN KEY (principal_id) REFERENCES principals(id) ON DELETE CASCADE
  DEFERRABLE INITIALLY DEFERRED
  NOT VALID;
