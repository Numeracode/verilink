package edgeverifier

import (
	"context"
	"errors"
	"math"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestWALDropOldestIncrementsCounter(t *testing.T) {
	m := NewMetrics()
	wal, err := NewDecisionWAL(WALConfig{MaxBytes: 400, MaxAge: -1, Metrics: m})
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 20; i++ {
		if err := wal.Append(Decision{
			Fingerprint: "fp",
			Action:      "allow",
			Score:       i,
			DecidedAt:   time.Now().UTC(),
		}); err != nil {
			t.Fatal(err)
		}
	}
	if m.DecisionsDropped.Load() == 0 {
		t.Fatal("expected drops when over capacity")
	}
	if wal.Bytes() > wal.MaxBytes() {
		t.Fatalf("bytes %d > max %d", wal.Bytes(), wal.MaxBytes())
	}
	if wal.Len() == 0 {
		t.Fatal("expected some retained entries")
	}
}

func TestWALNoDropBlocks(t *testing.T) {
	wal, err := NewDecisionWAL(WALConfig{MaxBytes: 200, MaxAge: -1, NoDrop: true})
	if err != nil {
		t.Fatal(err)
	}
	var hitFull bool
	for i := 0; i < 50; i++ {
		err := wal.Append(Decision{Fingerprint: "fp", Action: "deny", Score: i, DecidedAt: time.Now().UTC()})
		if errors.Is(err, ErrWALFull) {
			hitFull = true
			break
		}
		if err != nil {
			t.Fatal(err)
		}
	}
	if !hitFull {
		t.Fatal("expected ErrWALFull under no_drop")
	}
}

func TestWALFlushAckAndDiskRoundTrip(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "decisions.wal")
	m := NewMetrics()
	wal, err := NewDecisionWAL(WALConfig{Path: path, MaxBytes: defaultWALMaxBytes, MaxAge: -1, Metrics: m})
	if err != nil {
		t.Fatal(err)
	}
	if err := wal.Append(Decision{Fingerprint: "a", Action: "allow", Score: 1, DecidedAt: time.Now().UTC()}); err != nil {
		t.Fatal(err)
	}
	if err := wal.Append(Decision{Fingerprint: "b", Action: "passthrough", Score: 0, DecidedAt: time.Now().UTC()}); err != nil {
		t.Fatal(err)
	}

	var got FlushBatch
	transport := flushFunc(func(_ context.Context, batch FlushBatch) error {
		got = batch
		return nil
	})
	worker := NewFlushWorker(wal, transport, WithFlushBatchSize(10), WithFlushInterval(time.Hour))
	if err := worker.FlushOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(got.Decisions) != 2 || got.FirstWalSeq != 1 || got.LastWalSeq != 2 {
		t.Fatalf("batch=%+v", got)
	}
	if got.PayloadHash == "" || got.BatchID == "" {
		t.Fatal("missing batch id/hash")
	}
	again, err := buildFlushBatch(got.Decisions)
	if err != nil {
		t.Fatal(err)
	}
	if again.BatchID != got.BatchID {
		t.Fatalf("batch id should be deterministic: %s vs %s", got.BatchID, again.BatchID)
	}
	if wal.Len() != 0 {
		t.Fatalf("expected ack drain, len=%d", wal.Len())
	}
	if err := wal.Close(); err != nil {
		t.Fatal(err)
	}

	wal2, err := NewDecisionWAL(WALConfig{Path: path, MaxBytes: defaultWALMaxBytes, MaxAge: -1, Metrics: m})
	if err != nil {
		t.Fatal(err)
	}
	if wal2.Len() != 0 {
		t.Fatalf("reloaded len=%d", wal2.Len())
	}
	if err := wal2.Append(Decision{Fingerprint: "c", Action: "deny", Score: 3, DecidedAt: time.Now().UTC()}); err != nil {
		t.Fatal(err)
	}
	if err := wal2.Close(); err != nil {
		t.Fatal(err)
	}
	wal3, err := NewDecisionWAL(WALConfig{Path: path, MaxBytes: defaultWALMaxBytes, MaxAge: -1})
	if err != nil {
		t.Fatal(err)
	}
	defer wal3.Close()
	pending := wal3.Pending(10)
	if len(pending) != 1 || pending[0].Fingerprint != "c" || pending[0].WalSeq != 3 {
		t.Fatalf("pending=%+v", pending)
	}
}

func TestWALForcedNoDropStickyAgainstPolicy(t *testing.T) {
	wal, err := NewDecisionWAL(WALConfig{MaxBytes: 200, MaxAge: -1, NoDrop: true})
	if err != nil {
		t.Fatal(err)
	}
	wal.SetNoDrop(false) // policy tries to disable
	if !wal.NoDrop() || !wal.ForcedNoDrop() {
		t.Fatalf("forced no-drop must remain sticky: noDrop=%v forced=%v", wal.NoDrop(), wal.ForcedNoDrop())
	}
	var hitFull bool
	for i := 0; i < 50; i++ {
		err := wal.Append(Decision{Fingerprint: "fp", Action: "deny", Score: i, DecidedAt: time.Now().UTC()})
		if errors.Is(err, ErrWALFull) {
			hitFull = true
			break
		}
		if err != nil {
			t.Fatal(err)
		}
	}
	if !hitFull {
		t.Fatal("expected ErrWALFull with sticky forced no-drop")
	}
}

func TestWALTornTrailingLineRecovered(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "decisions.wal")
	wal, err := NewDecisionWAL(WALConfig{Path: path, MaxBytes: defaultWALMaxBytes, MaxAge: -1})
	if err != nil {
		t.Fatal(err)
	}
	if err := wal.Append(Decision{Fingerprint: "ok", Action: "allow", Score: 1, DecidedAt: time.Now().UTC()}); err != nil {
		t.Fatal(err)
	}
	if err := wal.Close(); err != nil {
		t.Fatal(err)
	}
	f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.WriteString(`{"t":"dec","wal_seq":2,"fingerprin`); err != nil {
		t.Fatal(err)
	}
	_ = f.Close()

	wal2, err := NewDecisionWAL(WALConfig{Path: path, MaxBytes: defaultWALMaxBytes, MaxAge: -1})
	if err != nil {
		t.Fatalf("torn tail should not fail load: %v", err)
	}
	defer wal2.Close()
	pending := wal2.Pending(10)
	if len(pending) != 1 || pending[0].Fingerprint != "ok" {
		t.Fatalf("pending=%+v", pending)
	}
}

func TestWALMidFileCorruptionFailsLoad(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "decisions.wal")
	wal, err := NewDecisionWAL(WALConfig{Path: path, MaxBytes: defaultWALMaxBytes, MaxAge: -1})
	if err != nil {
		t.Fatal(err)
	}
	if err := wal.Append(Decision{Fingerprint: "ok", Action: "allow", DecidedAt: time.Now().UTC()}); err != nil {
		t.Fatal(err)
	}
	if err := wal.Close(); err != nil {
		t.Fatal(err)
	}
	f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.WriteString("{\"t\":\"dec\",\"fingerprin\n{\"t\":\"ack\",\"through\":1}\n"); err != nil {
		t.Fatal(err)
	}
	_ = f.Close()

	if _, err := NewDecisionWAL(WALConfig{Path: path, MaxBytes: defaultWALMaxBytes, MaxAge: -1}); err == nil {
		t.Fatal("expected mid-file corruption to fail load")
	}
}

func TestWALAgeRetentionPrunesOldDecisions(t *testing.T) {
	wal, err := NewDecisionWAL(WALConfig{MaxBytes: defaultWALMaxBytes, MaxAge: time.Hour})
	if err != nil {
		t.Fatal(err)
	}
	old := time.Now().UTC().Add(-2 * time.Hour)
	if err := wal.Append(Decision{Fingerprint: "old", Action: "allow", DecidedAt: old}); err != nil {
		t.Fatal(err)
	}
	if err := wal.Append(Decision{Fingerprint: "new", Action: "deny", DecidedAt: time.Now().UTC()}); err != nil {
		t.Fatal(err)
	}
	pending := wal.Pending(10)
	if len(pending) != 1 || pending[0].Fingerprint != "new" {
		t.Fatalf("expected age prune, pending=%+v", pending)
	}
}

func TestSizedNoDropWALMaxBytes(t *testing.T) {
	if got := SizedNoDropWALMaxBytes(0, 900); got != defaultNoDropWALBytes {
		t.Fatalf("floor: %d", got)
	}
	if got := SizedNoDropWALMaxBytes(1<<20, 900); got != defaultNoDropWALBytes {
		t.Fatalf("expected floor for small rate, got %d", got)
	}
	if got := SizedNoDropWALMaxBytes(10<<20, 900); got <= defaultNoDropWALBytes {
		t.Fatalf("expected above floor, got %d", got)
	}
	if got := SizedNoDropWALMaxBytes(math.MaxFloat64/2, math.MaxInt); got != math.MaxInt64 {
		t.Fatalf("expected MaxInt64 clamp, got %d", got)
	}
}

type flushFunc func(context.Context, FlushBatch) error

func (f flushFunc) Flush(ctx context.Context, batch FlushBatch) error { return f(ctx, batch) }

func TestWALCompactKeepsAppendWorking(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "decisions.wal")
	wal, err := NewDecisionWAL(WALConfig{Path: path, MaxBytes: defaultWALMaxBytes, MaxAge: -1})
	if err != nil {
		t.Fatal(err)
	}
	defer wal.Close()

	// Build >1MiB of live bytes then ack so stale triggers compact.
	payload := strings.Repeat("f", 64<<10) // 64 KiB fingerprint field, 1 byte per char encoded
	for i := 0; i < 20; i++ {
		if err := wal.Append(Decision{
			Fingerprint: payload,
			Action:      "allow",
			Score:       i,
			DecidedAt:   time.Now().UTC(),
		}); err != nil {
			t.Fatal(err)
		}
	}
	pending := wal.Pending(100)
	if len(pending) == 0 {
		t.Fatal("expected pending")
	}
	lastSeq := pending[len(pending)-1].WalSeq
	if err := wal.AckThrough(lastSeq); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Size() > 1<<20 {
		t.Fatalf("expected compaction to shrink the wal, size=%d", info.Size())
	}
	if err := wal.Append(Decision{Fingerprint: "after-compact", Action: "deny", Score: 1, DecidedAt: time.Now().UTC()}); err != nil {
		t.Fatalf("append after compact: %v", err)
	}
	got := wal.Pending(10)
	if len(got) != 1 || got[0].Fingerprint != "after-compact" {
		t.Fatalf("pending=%+v", got)
	}
}

func TestSyncRunnerAppliesNoDropFromPolicy(t *testing.T) {
	wal, err := NewDecisionWAL(WALConfig{MaxBytes: 400, MaxAge: -1})
	if err != nil {
		t.Fatal(err)
	}
	store := NewStore()
	ApplySnapshot(store, &Snapshot{
		HighWaterVersion: 1,
		Scores:           map[string]ScoreEntry{},
		Keys:             map[string]KeyEntry{},
		Policy:           &Policy{NoDropDecisions: true, Threshold: 50, MaxSnapshotAgeSeconds: 300},
	})
	r := NewSyncRunner(nil, store, "", WithDecisionWAL(wal))
	r.syncWALPolicy()
	if !wal.NoDrop() {
		t.Fatal("expected SetNoDrop from synced policy")
	}
	ApplySnapshot(store, &Snapshot{
		HighWaterVersion: 2,
		Scores:           map[string]ScoreEntry{},
		Keys:             map[string]KeyEntry{},
		Policy:           nil,
	})
	r.syncWALPolicy()
	if wal.NoDrop() {
		t.Fatal("expected no-drop cleared when policy is absent")
	}
}

func TestFlushAllProgressesUnderConcurrentAppend(t *testing.T) {
	wal, err := NewDecisionWAL(WALConfig{MaxBytes: defaultWALMaxBytes, MaxAge: -1})
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 5; i++ {
		if err := wal.Append(Decision{Fingerprint: "x", Action: "allow", Score: i, DecidedAt: time.Now().UTC()}); err != nil {
			t.Fatal(err)
		}
	}
	var appended bool
	worker := NewFlushWorker(wal, flushFunc(func(_ context.Context, _ FlushBatch) error {
		if !appended {
			appended = true
			_ = wal.Append(Decision{Fingerprint: "y", Action: "deny", Score: 9, DecidedAt: time.Now().UTC()})
		}
		return nil
	}), WithFlushBatchSize(2))
	if err := worker.FlushAll(context.Background()); err != nil {
		t.Fatal(err)
	}
	if wal.Len() != 0 {
		t.Fatalf("expected full drain after concurrent append, len=%d", wal.Len())
	}
}
