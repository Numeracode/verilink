package edgeverifier

import "time"

// SyncMode is the edge degradation mode advertised on responses.
type SyncMode string

const (
	ModeOK       SyncMode = ""
	ModeDegraded SyncMode = "degraded"
	ModeStale    SyncMode = "stale"
	ModeExpired  SyncMode = "expired"
)

// EvaluateMode computes freshness mode from store + policy.
// reachable=false means the sync loop considers CP unreachable.
func EvaluateMode(store *Store, reachable bool, now time.Time) SyncMode {
	if store == nil {
		return ModeOK
	}
	pol := store.ActivePolicy()
	maxAge := 300
	failOpen := false
	if pol != nil {
		maxAge = clampAge(pol.MaxSnapshotAgeSeconds)
		failOpen = pol.FailOpenExpired
	}
	age := store.BytesAge()
	stale := age > time.Duration(maxAge)*time.Second
	if stale {
		if failOpen {
			return ModeExpired
		}
		return ModeStale
	}
	if !reachable {
		return ModeDegraded
	}
	_ = now
	return ModeOK
}

// RequireSignaturesFromPolicy returns whether unsigned requests must be denied.
func RequireSignaturesFromPolicy(store *Store, flagRequire bool) bool {
	if flagRequire {
		return true
	}
	if store == nil {
		return false
	}
	pol := store.ActivePolicy()
	if pol == nil {
		return false
	}
	return pol.UnsignedAction == "deny"
}

// AllowByScore applies threshold / blacklist policy. unknown → score 0.
func AllowByScore(store *Store, principalID string) (allow bool, score int, reason string) {
	if store == nil {
		return false, 0, "unknown"
	}
	pol := store.ActivePolicy()
	threshold := 50
	below := "deny"
	if pol != nil {
		threshold = pol.Threshold
		if pol.BelowThresholdAction != "" {
			below = pol.BelowThresholdAction
		}
	}
	entry, ok := store.LookupScore(principalID)
	if !ok {
		score = 0
		reason = "unknown"
	} else {
		score = entry.Score
		reason = entry.ScoreReason
		if entry.Blacklisted {
			return false, score, "blacklisted"
		}
	}
	if score >= threshold {
		return true, score, reason
	}
	if below == "allow" {
		return true, score, reason
	}
	return false, score, "below-threshold"
}
