package edgeverifier

import (
	"encoding/json"
	"fmt"
	"time"
)

// ApplySnapshot replaces the live store with snap (caller should set HighWaterVersion).
func ApplySnapshot(store *Store, snap *Snapshot) {
	if store == nil || snap == nil {
		return
	}
	if snap.Scores == nil {
		snap.Scores = make(map[string]ScoreEntry)
	}
	if snap.Keys == nil {
		snap.Keys = make(map[string]KeyEntry)
	}
	store.Swap(snap)
	store.NoteBytes()
}

// ApplyEvent applies one sync event idempotently. Events with syncVersion <= current HW are no-ops.
func ApplyEvent(store *Store, syncVersion int64, eventType string, payload json.RawMessage) error {
	if store == nil {
		return fmt.Errorf("nil store")
	}
	cur := store.Load()
	hw := int64(0)
	if cur != nil {
		hw = cur.HighWaterVersion
	}
	if syncVersion > 0 && syncVersion <= hw {
		return nil // already applied
	}

	next := CloneSnapshot(cur)

	switch eventType {
	case "score.upsert":
		var p struct {
			PrincipalID string `json:"principal_id"`
			EntityKind  string `json:"entity_kind"`
			Score       int    `json:"score"`
			Blacklisted bool   `json:"blacklisted"`
			ScoreReason string `json:"score_reason"`
		}
		if err := json.Unmarshal(payload, &p); err != nil {
			return fmt.Errorf("score.upsert: %w", err)
		}
		if p.PrincipalID == "" {
			return fmt.Errorf("score.upsert: missing principal_id")
		}
		next.Scores[p.PrincipalID] = ScoreEntry{
			PrincipalID: p.PrincipalID,
			EntityKind:  p.EntityKind,
			Score:       p.Score,
			Blacklisted: p.Blacklisted,
			ScoreReason: p.ScoreReason,
		}

	case "score.delete":
		var p struct {
			PrincipalID string `json:"principal_id"`
		}
		if err := json.Unmarshal(payload, &p); err != nil {
			return fmt.Errorf("score.delete: %w", err)
		}
		delete(next.Scores, p.PrincipalID)

	case "key.upsert":
		var p struct {
			PrincipalID  string  `json:"principal_id"`
			KeyID        string  `json:"key_id"`
			PublicKeyRaw string  `json:"public_key_raw"`
			ValidFrom    string  `json:"valid_from"`
			ValidUntil   *string `json:"valid_until"`
		}
		if err := json.Unmarshal(payload, &p); err != nil {
			return fmt.Errorf("key.upsert: %w", err)
		}
		raw, err := DecodePublicKeyRaw(p.PublicKeyRaw)
		if err != nil {
			return err
		}
		vf, err := parseTime(p.ValidFrom)
		if err != nil {
			return fmt.Errorf("key.upsert valid_from: %w", err)
		}
		var vu *time.Time
		if p.ValidUntil != nil && *p.ValidUntil != "" {
			t, err := parseTime(*p.ValidUntil)
			if err != nil {
				return fmt.Errorf("key.upsert valid_until: %w", err)
			}
			vu = &t
		}
		next.Keys[p.KeyID] = KeyEntry{
			PrincipalID:  p.PrincipalID,
			KeyID:        p.KeyID,
			PublicKeyRaw: raw,
			ValidFrom:    vf,
			ValidUntil:   vu,
		}

	case "key.revoke":
		var p struct {
			KeyID string `json:"key_id"`
		}
		if err := json.Unmarshal(payload, &p); err != nil {
			return fmt.Errorf("key.revoke: %w", err)
		}
		delete(next.Keys, p.KeyID)

	case "policy.replace":
		pol, err := parsePolicyPayload(payload)
		if err != nil {
			return err
		}
		next.Policy = pol

	case "cursor":
		// non-durable: only advance HW below
	default:
		// unknown types ignored (forward-compatible)
	}

	if syncVersion > next.HighWaterVersion {
		next.HighWaterVersion = syncVersion
	}
	store.Swap(next)
	store.NoteBytes()
	return nil
}

// AdvanceCursor advances high-water without mutating scores/keys (non-durable cursor event).
func AdvanceCursor(store *Store, highWater int64) {
	if store == nil {
		return
	}
	cur := store.Load()
	hw := int64(0)
	if cur != nil {
		hw = cur.HighWaterVersion
	}
	if highWater <= hw {
		store.NoteBytes()
		return
	}
	next := CloneSnapshot(cur)
	next.HighWaterVersion = highWater
	store.Swap(next)
	store.NoteBytes()
}

func parseTime(s string) (time.Time, error) {
	if s == "" {
		return time.Time{}, fmt.Errorf("empty time")
	}
	if t, err := time.Parse(time.RFC3339Nano, s); err == nil {
		return t, nil
	}
	return time.Parse(time.RFC3339, s)
}

func parsePolicyPayload(payload json.RawMessage) (*Policy, error) {
	var p struct {
		Threshold             int      `json:"threshold"`
		BelowThresholdAction  string   `json:"below_threshold_action"`
		UnsignedAction        string   `json:"unsigned_action"`
		FailOpenExpired       bool     `json:"fail_open_expired"`
		NoDropDecisions       bool     `json:"no_drop_decisions"`
		MaxSnapshotAgeSeconds int      `json:"max_snapshot_age_seconds"`
		AllowFingerprints     []string `json:"allow_fingerprints"`
		DenyFingerprints      []string `json:"deny_fingerprints"`
	}
	if err := json.Unmarshal(payload, &p); err != nil {
		return nil, fmt.Errorf("policy.replace: %w", err)
	}
	if p.MaxSnapshotAgeSeconds == 0 {
		p.MaxSnapshotAgeSeconds = 300
	}
	if p.Threshold == 0 && p.BelowThresholdAction == "" {
		p.Threshold = 50
	}
	if p.BelowThresholdAction == "" {
		p.BelowThresholdAction = "deny"
	}
	if p.UnsignedAction == "" {
		p.UnsignedAction = "passthrough"
	}
	return &Policy{
		Threshold:             p.Threshold,
		BelowThresholdAction:  p.BelowThresholdAction,
		UnsignedAction:        p.UnsignedAction,
		FailOpenExpired:       p.FailOpenExpired,
		NoDropDecisions:       p.NoDropDecisions,
		MaxSnapshotAgeSeconds: clampAge(p.MaxSnapshotAgeSeconds),
		AllowFingerprints:     p.AllowFingerprints,
		DenyFingerprints:      p.DenyFingerprints,
	}, nil
}

func clampAge(sec int) int {
	if sec < 60 {
		return 60
	}
	if sec > 1800 {
		return 1800
	}
	return sec
}
