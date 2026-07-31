package edgeverifier

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"time"
)

// FlushTransport delivers a decision batch to the control plane (or a stub).
type FlushTransport interface {
	Flush(ctx context.Context, batch FlushBatch) error
}

// FlushBatch is one idempotent decision delivery unit.
type FlushBatch struct {
	BatchID     string
	FirstWalSeq int64
	LastWalSeq  int64
	PayloadHash string
	Decisions   []Decision
}

// StubTransport logs batches and succeeds (Plan 8 PR B until CP ingest ships).
type StubTransport struct {
	Logger *log.Logger
}

// Flush implements FlushTransport.
func (s *StubTransport) Flush(ctx context.Context, batch FlushBatch) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if s != nil && s.Logger != nil {
		s.Logger.Printf("edgesync: stub flush batch_id=%s seq=%d..%d n=%d hash=%s",
			batch.BatchID, batch.FirstWalSeq, batch.LastWalSeq, len(batch.Decisions), batch.PayloadHash)
	}
	return nil
}

// FlushWorker periodically drains the WAL via FlushTransport.
type FlushWorker struct {
	WAL       *DecisionWAL
	Transport FlushTransport
	Logger    *log.Logger

	batchSize int
	interval  time.Duration
}

// FlushWorkerOption configures FlushWorker.
type FlushWorkerOption func(*FlushWorker)

// WithFlushBatchSize sets max decisions per flush (default 100).
func WithFlushBatchSize(n int) FlushWorkerOption {
	return func(w *FlushWorker) {
		if n > 0 {
			w.batchSize = n
		}
	}
}

// WithFlushInterval sets flush cadence (default 5s).
func WithFlushInterval(d time.Duration) FlushWorkerOption {
	return func(w *FlushWorker) {
		if d > 0 {
			w.interval = d
		}
	}
}

// NewFlushWorker builds a worker. Transport may be nil → StubTransport.
func NewFlushWorker(wal *DecisionWAL, transport FlushTransport, opts ...FlushWorkerOption) *FlushWorker {
	w := &FlushWorker{
		WAL:       wal,
		Transport: transport,
		Logger:    log.Default(),
		batchSize: 100,
		interval:  5 * time.Second,
	}
	if w.Transport == nil {
		w.Transport = &StubTransport{Logger: w.Logger}
	}
	for _, o := range opts {
		o(w)
	}
	if w.interval <= 0 {
		w.interval = 5 * time.Second
	}
	return w
}

// Run flushes until ctx is cancelled, then best-effort flushes all remaining.
func (w *FlushWorker) Run(ctx context.Context) {
	if w == nil || w.WAL == nil {
		return
	}
	ticker := time.NewTicker(w.interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			flushCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
			_ = w.FlushAll(flushCtx)
			cancel()
			return
		case <-ticker.C:
			_ = w.FlushOnce(ctx)
		}
	}
}

// FlushAll drains pending decisions in batches until empty or ctx ends.
func (w *FlushWorker) FlushAll(ctx context.Context) error {
	for {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if w.WAL.Len() == 0 {
			return nil
		}
		before := w.WAL.Len()
		if err := w.FlushOnce(ctx); err != nil {
			return err
		}
		if w.WAL.Len() >= before {
			return fmt.Errorf("flush made no progress (%d pending)", before)
		}
	}
}

// FlushOnce sends up to batchSize pending decisions.
func (w *FlushWorker) FlushOnce(ctx context.Context) error {
	if w == nil || w.WAL == nil || w.Transport == nil {
		return nil
	}
	pending := w.WAL.Pending(w.batchSize)
	if len(pending) == 0 {
		return nil
	}
	batch, err := buildFlushBatch(pending)
	if err != nil {
		return err
	}
	if err := w.Transport.Flush(ctx, batch); err != nil {
		w.logf("flush failed: %v", err)
		return err
	}
	if err := w.WAL.AckThrough(batch.LastWalSeq); err != nil {
		w.logf("ack after flush failed: %v", err)
		return err
	}
	return nil
}

func buildFlushBatch(decisions []Decision) (FlushBatch, error) {
	payload, err := json.Marshal(decisions)
	if err != nil {
		return FlushBatch{}, err
	}
	sum := sha256.Sum256(payload)
	// Deterministic batch id from payload hash so retries dedupe on the same content.
	id := fmt.Sprintf("%x-%x-%x-%x-%x", sum[0:4], sum[4:6], sum[6:8], sum[8:10], sum[10:16])
	return FlushBatch{
		BatchID:     id,
		FirstWalSeq: decisions[0].WalSeq,
		LastWalSeq:  decisions[len(decisions)-1].WalSeq,
		PayloadHash: hex.EncodeToString(sum[:]),
		Decisions:   decisions,
	}, nil
}

func (w *FlushWorker) logf(format string, args ...any) {
	if w != nil && w.Logger != nil {
		w.Logger.Printf("edgesync: "+format, args...)
	}
}
