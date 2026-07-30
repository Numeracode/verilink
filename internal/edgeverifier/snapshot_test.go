package edgeverifier

import (
	"crypto/ed25519"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestSnapshotAtomicSwapMissUnknown(t *testing.T) {
	s := NewStore()
	if _, ok := s.LookupScore("p1"); ok {
		t.Fatal("expected miss on empty store")
	}
	s.Swap(&Snapshot{
		HighWaterVersion: 3,
		Scores: map[string]ScoreEntry{
			"p1": {PrincipalID: "p1", Score: 80},
		},
		Keys: map[string]KeyEntry{},
	})
	e, ok := s.LookupScore("p1")
	if !ok || e.Score != 80 {
		t.Fatalf("got %+v ok=%v", e, ok)
	}
	if s.HighWater() != 3 {
		t.Fatalf("hw=%d", s.HighWater())
	}
}

func TestApplyEventIdempotent(t *testing.T) {
	s := NewStore()
	payload, err := json.Marshal(map[string]any{
		"principal_id": "p1",
		"entity_kind":  "agent",
		"score":        70,
		"blacklisted":  false,
		"score_reason": "ok",
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := ApplyEvent(s, 5, "score.upsert", payload); err != nil {
		t.Fatal(err)
	}
	if err := ApplyEvent(s, 5, "score.upsert", payload); err != nil {
		t.Fatal(err)
	}
	if s.HighWater() != 5 {
		t.Fatalf("hw=%d", s.HighWater())
	}
	payload2, err := json.Marshal(map[string]any{
		"principal_id": "p1",
		"score":        10,
		"entity_kind":  "agent",
		"blacklisted":  false,
		"score_reason": "x",
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := ApplyEvent(s, 4, "score.upsert", payload2); err != nil {
		t.Fatal(err)
	}
	e, _ := s.LookupScore("p1")
	if e.Score != 70 {
		t.Fatalf("score mutated on stale event: %d", e.Score)
	}
}

func TestAdvanceCursorNoClone(t *testing.T) {
	s := NewStore()
	ApplySnapshot(s, &Snapshot{
		HighWaterVersion: 1,
		Scores:           map[string]ScoreEntry{"p1": {PrincipalID: "p1", Score: 1}},
		Keys:             map[string]KeyEntry{},
	})
	before := s.Load()
	AdvanceCursor(s, 10)
	if s.HighWater() != 10 {
		t.Fatalf("hw=%d", s.HighWater())
	}
	if s.Load() != before {
		t.Fatal("AdvanceCursor should not replace snapshot pointer")
	}
}

func TestDiskRoundTripAndDirFsync(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "snapshot.json")
	pub, _, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC().Truncate(time.Second)
	snap := &Snapshot{
		HighWaterVersion: 42,
		Scores: map[string]ScoreEntry{
			"p1": {PrincipalID: "p1", EntityKind: "agent", Score: 90, ScoreReason: "r"},
		},
		Keys: map[string]KeyEntry{
			"kid1": {PrincipalID: "p1", KeyID: "kid1", PublicKeyRaw: []byte(pub), ValidFrom: now},
		},
		Policy: &Policy{Threshold: 40, UnsignedAction: "deny", MaxSnapshotAgeSeconds: 120},
	}
	if err := SaveSnapshot(path, snap); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatal(err)
	}
	loaded, err := LoadSnapshot(path)
	if err != nil {
		t.Fatal(err)
	}
	if loaded.HighWaterVersion != 42 {
		t.Fatalf("hw=%d", loaded.HighWaterVersion)
	}
	if loaded.Scores["p1"].Score != 90 {
		t.Fatalf("score=%v", loaded.Scores["p1"])
	}
	if len(loaded.Keys["kid1"].PublicKeyRaw) != ed25519.PublicKeySize {
		t.Fatal("bad key")
	}
	if loaded.Policy.Threshold != 40 {
		t.Fatalf("policy=%+v", loaded.Policy)
	}
}

func TestParseRetryMs(t *testing.T) {
	if v, ok := parseRetryMs("5000"); !ok || v != 5000 {
		t.Fatalf("%v %v", v, ok)
	}
	if _, ok := parseRetryMs("0"); ok {
		t.Fatal("zero should be invalid")
	}
	if _, ok := parseRetryMs("abc"); ok {
		t.Fatal("non-numeric")
	}
	if v, ok := parseRetryMs("999999"); !ok || v != maxBackoffMs {
		t.Fatalf("expected clamp to %d, got %d ok=%v", maxBackoffMs, v, ok)
	}
}

func TestEvaluateModeStale(t *testing.T) {
	s := NewStore()
	ApplySnapshot(s, &Snapshot{
		HighWaterVersion: 1,
		Scores:           map[string]ScoreEntry{},
		Keys:             map[string]KeyEntry{},
		Policy:           &Policy{MaxSnapshotAgeSeconds: 60, FailOpenExpired: false},
	})
	old := time.Now().Add(-2 * time.Minute)
	s.lastBytes.Store(&old)
	if mode := EvaluateMode(s, true, time.Now()); mode != ModeStale {
		t.Fatalf("mode=%s", mode)
	}
	s.ActivePolicy().FailOpenExpired = true
	if mode := EvaluateMode(s, true, time.Now()); mode != ModeExpired {
		t.Fatalf("mode=%s", mode)
	}
}

func TestKeyValidityWindow(t *testing.T) {
	s := NewStore()
	pub, _, _ := ed25519.GenerateKey(nil)
	from := time.Now().Add(time.Hour)
	s.Swap(&Snapshot{
		Keys: map[string]KeyEntry{
			"k": {KeyID: "k", PrincipalID: "p", PublicKeyRaw: []byte(pub), ValidFrom: from},
		},
		Scores: map[string]ScoreEntry{},
	})
	if _, ok := s.LookupKey("k", time.Now()); ok {
		t.Fatal("key should be invalid before valid_from")
	}
}

func TestRequireSignaturesNilStore(t *testing.T) {
	if RequireSignaturesFromPolicy(nil, false) {
		t.Fatal("nil store should not require signatures")
	}
	if !RequireSignaturesFromPolicy(nil, true) {
		t.Fatal("flag should still require")
	}
}

func TestParseSnapshotInvalidHW(t *testing.T) {
	_, err := parseSnapshotJSON([]byte(`{"ok":true,"data":{"highWaterVersion":"nope","scores":[],"keys":[]}}`))
	if err == nil {
		t.Fatal("expected error for invalid highWaterVersion")
	}
}

func TestApplyEventRejectsZeroVersion(t *testing.T) {
	s := NewStore()
	payload, err := json.Marshal(map[string]any{
		"principal_id": "p1",
		"score":        1,
		"entity_kind":  "agent",
		"blacklisted":  false,
		"score_reason": "",
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := ApplyEvent(s, 0, "score.upsert", payload); err == nil {
		t.Fatal("expected reject sync_version 0")
	}
}
