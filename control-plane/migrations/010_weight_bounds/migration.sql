-- Align weight columns with trust-engine gRPC bounds [0,1].
-- Add+validate replacement CHECKs before dropping the live >=0 constraints.

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

ALTER TABLE issuers
  ADD CONSTRAINT issuers_trust_weight_check_v2
  CHECK (trust_weight >= 0 AND trust_weight <= 1) NOT VALID;
ALTER TABLE issuers VALIDATE CONSTRAINT issuers_trust_weight_check_v2;
ALTER TABLE issuers DROP CONSTRAINT issuers_trust_weight_check;
ALTER TABLE issuers RENAME CONSTRAINT issuers_trust_weight_check_v2 TO issuers_trust_weight_check;

ALTER TABLE bootstrap_issuers
  ADD CONSTRAINT bootstrap_issuers_current_weight_check_v2
  CHECK (current_weight >= 0 AND current_weight <= 1) NOT VALID;
ALTER TABLE bootstrap_issuers VALIDATE CONSTRAINT bootstrap_issuers_current_weight_check_v2;
ALTER TABLE bootstrap_issuers DROP CONSTRAINT bootstrap_issuers_current_weight_check;
ALTER TABLE bootstrap_issuers
  RENAME CONSTRAINT bootstrap_issuers_current_weight_check_v2 TO bootstrap_issuers_current_weight_check;
