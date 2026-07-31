package edgeverifier

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestWALDropOldestIncrementsCounter(t *testing.T) {
	m := NewMetrics()
	wal, err := NewDecisionWAL(WALConfig{MaxBytes: 400, Metrics: m})
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
	wal, err := NewDecisionWAL(WALConfig{MaxBytes: 200, NoDrop: true})
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
	wal, err := NewDecisionWAL(WALConfig{Path: path, MaxBytes: defaultWALMaxBytes, Metrics: m})
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

	wal2, err := NewDecisionWAL(WALConfig{Path: path, MaxBytes: defaultWALMaxBytes, Metrics: m})
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
	wal3, err := NewDecisionWAL(WALConfig{Path: path, MaxBytes: defaultWALMaxBytes})
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
	wal, err := NewDecisionWAL(WALConfig{MaxBytes: 200, NoDrop: true})
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
	wal, err := NewDecisionWAL(WALConfig{Path: path, MaxBytes: defaultWALMaxBytes})
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

	wal2, err := NewDecisionWAL(WALConfig{Path: path, MaxBytes: defaultWALMaxBytes})
	if err != nil {
		t.Fatalf("torn tail should not fail load: %v", err)
	}
	defer wal2.Close()
	pending := wal2.Pending(10)
	if len(pending) != 1 || pending[0].Fingerprint != "ok" {
		t.Fatalf("pending=%+v", pending)
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
}

type flushFunc func(context.Context, FlushBatch) error

func (f flushFunc) Flush(ctx context.Context, batch FlushBatch) error { return f(ctx, batch) }

func TestWALCompactKeepsAppendWorking(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "decisions.wal")
	wal, err := NewDecisionWAL(WALConfig{Path: path, MaxBytes: defaultWALMaxBytes})
	if err != nil {
		t.Fatal(err)
	}
	defer wal.Close()

	// Build >1MiB of live bytes then ack so stale triggers compact.
	payload := string(make([]byte, 64<<10)) // 64 KiB fingerprint field
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
	if err := wal.Append(Decision{Fingerprint: "after-compact", Action: "deny", Score: 1, DecidedAt: time.Now().UTC()}); err != nil {
		t.Fatalf("append after compact: %v", err)
	}
	got := wal.Pending(10)
	if len(got) != 1 || got[0].Fingerprint != "after-compact" {
		t.Fatalf("pending=%+v", got)
	}
}

func TestSyncRunnerAppliesNoDropFromPolicy(t *testing.T) {
	wal, err := NewDecisionWAL(WALConfig{MaxBytes: 400})
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
		Policy:           &Policy{NoDropDecisions: false, Threshold: 50, MaxSnapshotAgeSeconds: 300},
	})
	r.syncWALPolicy()
	if wal.NoDrop() {
		t.Fatal("expected no-drop cleared when policy disables it")
	}
}
