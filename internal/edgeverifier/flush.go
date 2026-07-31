package edgeverifier

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"math/big"
	"time"
)

// FlushTransport delivers a decision batch to the control plane (or a stub).
type FlushTransport interface {
	Flush(ctx context.Context, batch FlushBatch) error
}

// FlushBatch is one idempotent decision delivery unit.
// Decisions may carry PrincipalID/Fingerprint; the edge WAL retains them at most
// DecisionWAL.MaxAge (default 24h) regardless of flush success.
type FlushBatch struct {
	BatchID     string     `json:"batch_id"`
	FirstWalSeq int64      `json:"first_wal_seq"`
	LastWalSeq  int64      `json:"last_wal_seq"`
	PayloadHash string     `json:"payload_hash"`
	Decisions   []Decision `json:"decisions"`
}

// MarshalJSON emits decisions as decisionWire so payload_hash verification matches
// the canonical bytes hashed in buildFlushBatch (no omitempty drift).
func (b FlushBatch) MarshalJSON() ([]byte, error) {
	wires := make([]decisionWire, len(b.Decisions))
	for i, d := range b.Decisions {
		wires[i] = toDecisionWire(d)
	}
	return json.Marshal(struct {
		BatchID     string         `json:"batch_id"`
		FirstWalSeq int64          `json:"first_wal_seq"`
		LastWalSeq  int64          `json:"last_wal_seq"`
		PayloadHash string         `json:"payload_hash"`
		Decisions   []decisionWire `json:"decisions"`
	}{
		BatchID:     b.BatchID,
		FirstWalSeq: b.FirstWalSeq,
		LastWalSeq:  b.LastWalSeq,
		PayloadHash: b.PayloadHash,
		Decisions:   wires,
	})
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
// Failed flushes back off exponentially (with jitter) up to 30s so transient
// control-plane 5xx does not hammer every base interval.
func (w *FlushWorker) Run(ctx context.Context) {
	if w == nil || w.WAL == nil {
		return
	}
	interval := w.interval
	if interval <= 0 {
		interval = 5 * time.Second
	}
	backoff := time.Duration(0)
	for {
		wait := interval
		if backoff > 0 {
			wait = backoff
		}
		timer := time.NewTimer(wait)
		select {
		case <-ctx.Done():
			if !timer.Stop() {
				select {
				case <-timer.C:
				default:
				}
			}
			flushCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
			_ = w.FlushAll(flushCtx)
			cancel()
			return
		case <-timer.C:
			flushCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
			err := w.FlushOnce(flushCtx)
			cancel()
			if err != nil {
				if backoff == 0 {
					backoff = interval
				} else {
					backoff *= 2
				}
				const maxBackoff = 30 * time.Second
				if backoff > maxBackoff {
					backoff = maxBackoff
				}
				// ±20% jitter
				j := time.Duration(randInt63n(int64(backoff/5) + 1))
				backoff = backoff - backoff/10 + j
			} else {
				backoff = 0
			}
		}
	}
}

// FlushAll drains pending decisions in batches until empty or ctx ends.
// Progress is measured by acked wal_seq so concurrent Append cannot false-trigger
// a "no progress" failure during shutdown.
func (w *FlushWorker) FlushAll(ctx context.Context) error {
	if w == nil || w.WAL == nil {
		return nil
	}
	var lastAcked int64
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		pending := w.WAL.Pending(1)
		if len(pending) == 0 {
			return nil
		}
		if pending[0].WalSeq <= lastAcked {
			return fmt.Errorf("flush made no progress (wal_seq=%d)", pending[0].WalSeq)
		}
		head := pending[0].WalSeq
		if err := w.FlushOnce(ctx); err != nil {
			return err
		}
		after := w.WAL.Pending(1)
		if len(after) == 0 {
			return nil
		}
		if after[0].WalSeq <= head {
			return fmt.Errorf("flush made no progress (wal_seq=%d)", head)
		}
		lastAcked = head
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
	wires := make([]decisionWire, len(decisions))
	for i, d := range decisions {
		wires[i] = toDecisionWire(d)
	}
	payload, err := json.Marshal(wires)
	if err != nil {
		return FlushBatch{}, err
	}
	sum := sha256.Sum256(payload)
	// Deterministic UUID from payload hash so retries dedupe on the same content.
	id := fmt.Sprintf("%x-%x-%x-%x-%x", sum[0:4], sum[4:6], sum[6:8], sum[8:10], sum[10:16])
	out := make([]Decision, len(decisions))
	copy(out, decisions)
	return FlushBatch{
		BatchID:     id,
		FirstWalSeq: decisions[0].WalSeq,
		LastWalSeq:  decisions[len(decisions)-1].WalSeq,
		PayloadHash: hex.EncodeToString(sum[:]),
		Decisions:   out,
	}, nil
}

// decisionWire is the cross-language canonical decision JSON (no omitempty).
type decisionWire struct {
	WalSeq      int64  `json:"wal_seq"`
	Fingerprint string `json:"fingerprint"`
	PrincipalID string `json:"principal_id"`
	Score       int    `json:"score"`
	Blacklisted bool   `json:"blacklisted"`
	ScoreReason string `json:"score_reason"`
	Action      string `json:"action"`
	DecidedAt   string `json:"decided_at"`
}

func toDecisionWire(d Decision) decisionWire {
	return decisionWire{
		WalSeq:      d.WalSeq,
		Fingerprint: d.Fingerprint,
		PrincipalID: d.PrincipalID,
		Score:       d.Score,
		Blacklisted: d.Blacklisted,
		ScoreReason: d.ScoreReason,
		Action:      d.Action,
		DecidedAt:   d.DecidedAt.UTC().Format(time.RFC3339Nano),
	}
}

func (w *FlushWorker) logf(format string, args ...any) {
	if w != nil && w.Logger != nil {
		w.Logger.Printf("edgesync: "+format, args...)
	}
}

// randInt63n returns a non-negative int64 in [0,n) using crypto/rand.
func randInt63n(n int64) int64 {
	if n <= 0 {
		return 0
	}
	v, err := rand.Int(rand.Reader, big.NewInt(n))
	if err != nil {
		return 0
	}
	return v.Int64()
}
