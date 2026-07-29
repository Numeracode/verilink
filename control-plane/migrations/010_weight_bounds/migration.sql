-- Align weight columns with trust-engine gRPC bounds [0,1].

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM issuers WHERE trust_weight < 0 OR trust_weight > 1
  ) THEN
    RAISE EXCEPTION
      'Cannot apply 010_weight_bounds: issuers.trust_weight has rows outside [0,1]';
  END IF;

  IF EXISTS (
    SELECT 1 FROM bootstrap_issuers WHERE current_weight < 0 OR current_weight > 1
  ) THEN
    RAISE EXCEPTION
      'Cannot apply 010_weight_bounds: bootstrap_issuers.current_weight has rows outside [0,1]';
  END IF;
END $$;

ALTER TABLE issuers DROP CONSTRAINT issuers_trust_weight_check;
ALTER TABLE issuers
  ADD CONSTRAINT issuers_trust_weight_check
  CHECK (trust_weight >= 0 AND trust_weight <= 1) NOT VALID;
ALTER TABLE issuers VALIDATE CONSTRAINT issuers_trust_weight_check;

ALTER TABLE bootstrap_issuers DROP CONSTRAINT bootstrap_issuers_current_weight_check;
ALTER TABLE bootstrap_issuers
  ADD CONSTRAINT bootstrap_issuers_current_weight_check
  CHECK (current_weight >= 0 AND current_weight <= 1) NOT VALID;
ALTER TABLE bootstrap_issuers VALIDATE CONSTRAINT bootstrap_issuers_current_weight_check;
