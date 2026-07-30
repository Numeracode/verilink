package edgeverifier

import "fmt"

// validateSnapshot rejects malformed full snapshots before they become live state.
func validateSnapshot(snap *Snapshot) error {
	if snap == nil {
		return fmt.Errorf("nil snapshot")
	}
	if snap.HighWaterVersion < 0 {
		return fmt.Errorf("negative highWaterVersion %d", snap.HighWaterVersion)
	}
	if snap.Scores == nil {
		snap.Scores = make(map[string]ScoreEntry)
	}
	if snap.Keys == nil {
		snap.Keys = make(map[string]KeyEntry)
	}
	for id, s := range snap.Scores {
		if id == "" || s.PrincipalID == "" {
			return fmt.Errorf("score entry missing principal_id")
		}
		if id != s.PrincipalID {
			return fmt.Errorf("score map key %q != principal_id %q", id, s.PrincipalID)
		}
	}
	for id, k := range snap.Keys {
		if id == "" || k.KeyID == "" {
			return fmt.Errorf("key entry missing key_id")
		}
		if k.PrincipalID == "" {
			return fmt.Errorf("key %q missing principal_id", id)
		}
		if id != k.KeyID {
			return fmt.Errorf("key map key %q != key_id %q", id, k.KeyID)
		}
		if len(k.PublicKeyRaw) != 32 {
			return fmt.Errorf("key %q invalid public key length", id)
		}
		if k.ValidFrom.IsZero() {
			return fmt.Errorf("key %q missing valid_from", id)
		}
		if k.ValidUntil != nil && !k.ValidUntil.After(k.ValidFrom) {
			return fmt.Errorf("key %q valid_until must be after valid_from", id)
		}
	}
	if snap.Policy != nil {
		if err := normalizeAndValidatePolicy(snap.Policy); err != nil {
			return err
		}
	}
	return nil
}

func normalizeAndValidatePolicy(p *Policy) error {
	if p.MaxSnapshotAgeSeconds == 0 {
		p.MaxSnapshotAgeSeconds = 300
	}
	p.MaxSnapshotAgeSeconds = clampAge(p.MaxSnapshotAgeSeconds)
	if p.BelowThresholdAction == "" {
		p.BelowThresholdAction = "deny"
	}
	if p.UnsignedAction == "" {
		p.UnsignedAction = "passthrough"
	}
	switch p.BelowThresholdAction {
	case "allow", "deny":
	default:
		return fmt.Errorf("unsupported below_threshold_action %q", p.BelowThresholdAction)
	}
	switch p.UnsignedAction {
	case "passthrough", "deny":
	default:
		return fmt.Errorf("unsupported unsigned_action %q", p.UnsignedAction)
	}
	return nil
}
