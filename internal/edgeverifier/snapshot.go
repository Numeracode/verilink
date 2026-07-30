package edgeverifier

import (
	"crypto/ed25519"
	"encoding/base64"
	"fmt"
	"sync/atomic"
	"time"
)

// ScoreEntry is a principal's network score from the control-plane snapshot/SSE.
type ScoreEntry struct {
	PrincipalID string
	EntityKind  string
	Score       int
	Blacklisted bool
	ScoreReason string
}

// KeyEntry is an active verification key.
type KeyEntry struct {
	PrincipalID  string
	KeyID        string
	PublicKeyRaw []byte // raw 32-byte ed25519
	ValidFrom    time.Time
	ValidUntil   *time.Time // nil = no expiry
}

// Policy is the tenant active policy (subset used by the edge).
type Policy struct {
	Threshold             int
	BelowThresholdAction  string // allow|deny
	UnsignedAction        string // passthrough|deny
	FailOpenExpired       bool
	NoDropDecisions       bool
	MaxSnapshotAgeSeconds int
	AllowFingerprints     []string
	DenyFingerprints      []string
}

// Snapshot is an immutable generation of edge sync state.
type Snapshot struct {
	HighWaterVersion int64
	Scores           map[string]ScoreEntry // principal_id
	Keys             map[string]KeyEntry   // key_id
	Policy           *Policy
}

// Store holds the live snapshot behind an atomic pointer and tracks SSE freshness.
type Store struct {
	ptr       atomic.Pointer[Snapshot]
	lastBytes atomic.Pointer[time.Time]
}

// NewStore returns an empty store (cache miss until first swap).
func NewStore() *Store {
	return &Store{}
}

// Load returns the current snapshot, or nil if none loaded.
func (s *Store) Load() *Snapshot {
	if s == nil {
		return nil
	}
	return s.ptr.Load()
}

// Swap replaces the live snapshot atomically.
func (s *Store) Swap(next *Snapshot) {
	if s == nil || next == nil {
		return
	}
	s.ptr.Store(next)
}

// NoteBytes records that authenticated SSE bytes were received (freshness).
func (s *Store) NoteBytes() {
	if s == nil {
		return
	}
	now := time.Now()
	s.lastBytes.Store(&now)
}

// LastBytesAt returns the last freshness timestamp, or zero if never noted.
func (s *Store) LastBytesAt() time.Time {
	if s == nil {
		return time.Time{}
	}
	t := s.lastBytes.Load()
	if t == nil {
		return time.Time{}
	}
	return *t
}

// BytesAge returns time since last authenticated bytes, or a large duration if never.
func (s *Store) BytesAge() time.Duration {
	t := s.LastBytesAt()
	if t.IsZero() {
		return 24 * time.Hour
	}
	return time.Since(t)
}

// HighWater returns the live high-water version, or 0.
func (s *Store) HighWater() int64 {
	snap := s.Load()
	if snap == nil {
		return 0
	}
	return snap.HighWaterVersion
}

// LookupScore returns the score for a principal, or (0, false) on miss.
func (s *Store) LookupScore(principalID string) (ScoreEntry, bool) {
	snap := s.Load()
	if snap == nil {
		return ScoreEntry{}, false
	}
	e, ok := snap.Scores[principalID]
	return e, ok
}

// LookupKey returns a key if present and within its validity window at now.
func (s *Store) LookupKey(keyID string, now time.Time) (KeyEntry, bool) {
	snap := s.Load()
	if snap == nil {
		return KeyEntry{}, false
	}
	e, ok := snap.Keys[keyID]
	if !ok {
		return KeyEntry{}, false
	}
	if now.Before(e.ValidFrom) {
		return KeyEntry{}, false
	}
	if e.ValidUntil != nil && !now.Before(*e.ValidUntil) {
		return KeyEntry{}, false
	}
	return e, true
}

// PublicKey returns the ed25519 public key for keyID when valid.
func (s *Store) PublicKey(keyID string, now time.Time) (ed25519.PublicKey, error) {
	e, ok := s.LookupKey(keyID, now)
	if !ok {
		return nil, fmt.Errorf("key not found or outside validity window: %s", keyID)
	}
	if len(e.PublicKeyRaw) != ed25519.PublicKeySize {
		return nil, fmt.Errorf("invalid public key length for %s", keyID)
	}
	return ed25519.PublicKey(e.PublicKeyRaw), nil
}

// ActivePolicy returns the live policy, or nil.
func (s *Store) ActivePolicy() *Policy {
	snap := s.Load()
	if snap == nil {
		return nil
	}
	return snap.Policy
}

// CloneSnapshot deep-copies maps for copy-on-write apply.
func CloneSnapshot(src *Snapshot) *Snapshot {
	if src == nil {
		return &Snapshot{
			Scores: make(map[string]ScoreEntry),
			Keys:   make(map[string]KeyEntry),
		}
	}
	out := &Snapshot{
		HighWaterVersion: src.HighWaterVersion,
		Scores:           make(map[string]ScoreEntry, len(src.Scores)),
		Keys:             make(map[string]KeyEntry, len(src.Keys)),
		Policy:           src.Policy, // policy treated as immutable replacement
	}
	for k, v := range src.Scores {
		out.Scores[k] = v
	}
	for k, v := range src.Keys {
		out.Keys[k] = v
	}
	return out
}

// DecodePublicKeyRaw accepts standard or raw URL base64 for a 32-byte key.
func DecodePublicKeyRaw(b64 string) ([]byte, error) {
	raw, err := base64.StdEncoding.DecodeString(b64)
	if err != nil {
		raw, err = base64.RawURLEncoding.DecodeString(b64)
		if err != nil {
			return nil, fmt.Errorf("decode public key: %w", err)
		}
	}
	if len(raw) != ed25519.PublicKeySize {
		return nil, fmt.Errorf("public key length %d, want %d", len(raw), ed25519.PublicKeySize)
	}
	return raw, nil
}
