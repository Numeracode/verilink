package edgeverifier

import (
	"context"
	"errors"
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
	if wal.Len() != 0 {
		t.Fatalf("expected ack drain, len=%d", wal.Len())
	}
	if err := wal.Close(); err != nil {
		t.Fatal(err)
	}

	// persist empty + reload
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
	if len(pending) != 1 || pending[0].Fingerprint != "c" || pending[0].WalSeq < 1 {
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

func TestWALAppendCostDoesNotScaleWithLength(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "decisions.wal")
	wal, err := NewDecisionWAL(WALConfig{Path: path, MaxBytes: defaultWALMaxBytes})
	if err != nil {
		t.Fatal(err)
	}
	defer wal.Close()

	const warm = 200
	const sample = 50
	for i := 0; i < warm; i++ {
		if err := wal.Append(Decision{Fingerprint: "warm", Action: "allow", Score: i, DecidedAt: time.Now().UTC()}); err != nil {
			t.Fatal(err)
		}
	}
	startSmall := time.Now()
	for i := 0; i < sample; i++ {
		if err := wal.Append(Decision{Fingerprint: "a", Action: "allow", Score: i, DecidedAt: time.Now().UTC()}); err != nil {
			t.Fatal(err)
		}
	}
	small := time.Since(startSmall)

	for i := 0; i < warm*4; i++ {
		if err := wal.Append(Decision{Fingerprint: "grow", Action: "allow", Score: i, DecidedAt: time.Now().UTC()}); err != nil {
			t.Fatal(err)
		}
	}
	startLarge := time.Now()
	for i := 0; i < sample; i++ {
		if err := wal.Append(Decision{Fingerprint: "b", Action: "allow", Score: i, DecidedAt: time.Now().UTC()}); err != nil {
			t.Fatal(err)
		}
	}
	large := time.Since(startLarge)

	// Append path must stay roughly O(1); allow generous jitter for CI disks.
	if large > small*20+50*time.Millisecond {
		t.Fatalf("append latency appears to scale with WAL length: small=%s large=%s len=%d", small, large, wal.Len())
	}
}

func TestSizedNoDropWALMaxBytes(t *testing.T) {
	if got := SizedNoDropWALMaxBytes(0, 900); got != defaultNoDropWALBytes {
		t.Fatalf("floor: %d", got)
	}
	if got := SizedNoDropWALMaxBytes(1<<20, 900); got <= defaultNoDropWALBytes {
		// 1MiB/s * 900 * 1.5 = ~1.35 GiB < 8 GiB floor
		if got != defaultNoDropWALBytes {
			t.Fatalf("expected floor, got %d", got)
		}
	}
	if got := SizedNoDropWALMaxBytes(10<<20, 900); got <= defaultNoDropWALBytes {
		t.Fatalf("expected above floor, got %d", got)
	}
}

type flushFunc func(context.Context, FlushBatch) error

func (f flushFunc) Flush(ctx context.Context, batch FlushBatch) error { return f(ctx, batch) }
