package edgeverifier

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"
)

const (
	defaultWALMaxBytes    = 256 << 20 // 256 MiB
	defaultNoDropWALBytes = 8 << 30   // 8 GiB
	defaultOutageSeconds  = 900
	walSchemaVersion      = 1
)

// ErrWALFull is returned by Append when no_drop_decisions is set and the WAL is full.
var ErrWALFull = errors.New("decision WAL full (no_drop_decisions)")

// Decision is one edge trust outcome destined for control-plane ingest.
type Decision struct {
	WalSeq      int64     `json:"wal_seq"`
	Fingerprint string    `json:"fingerprint"`
	PrincipalID string    `json:"principal_id,omitempty"`
	Score       int       `json:"score"`
	Blacklisted bool      `json:"blacklisted"`
	ScoreReason string    `json:"score_reason,omitempty"`
	Action      string    `json:"action"` // allow|deny|passthrough
	DecidedAt   time.Time `json:"decided_at"`
}

// DecisionWAL is a bounded, append-only local decision log with drop-oldest or no-drop.
type DecisionWAL struct {
	mu       sync.Mutex
	path     string
	maxBytes int64
	noDrop   bool
	metrics  *Metrics

	nextSeq int64
	entries []walEntry
	bytes   int64
}

type walEntry struct {
	rec  Decision
	size int64
}

// WALConfig configures DecisionWAL.
type WALConfig struct {
	Path     string
	MaxBytes int64
	NoDrop   bool
	Metrics  *Metrics
}

// NewDecisionWAL creates a WAL. Loads existing JSONL from Path when set.
func NewDecisionWAL(cfg WALConfig) (*DecisionWAL, error) {
	maxBytes := cfg.MaxBytes
	if maxBytes <= 0 {
		if cfg.NoDrop {
			maxBytes = defaultNoDropWALBytes
		} else {
			maxBytes = defaultWALMaxBytes
		}
	}
	w := &DecisionWAL{
		path:     cfg.Path,
		maxBytes: maxBytes,
		noDrop:   cfg.NoDrop,
		metrics:  cfg.Metrics,
		nextSeq:  1,
	}
	if cfg.Path != "" {
		if err := w.load(); err != nil && !errors.Is(err, os.ErrNotExist) {
			return nil, err
		}
	}
	w.publishBytes()
	return w, nil
}

// SetNoDrop updates the no-drop policy (e.g. from synced tenant policy).
func (w *DecisionWAL) SetNoDrop(v bool) {
	if w == nil {
		return
	}
	w.mu.Lock()
	w.noDrop = v
	w.mu.Unlock()
}

// NoDrop reports whether writers block when full.
func (w *DecisionWAL) NoDrop() bool {
	if w == nil {
		return false
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.noDrop
}

// MaxBytes returns the configured capacity.
func (w *DecisionWAL) MaxBytes() int64 {
	if w == nil {
		return 0
	}
	return w.maxBytes
}

// Len returns pending decision count.
func (w *DecisionWAL) Len() int {
	if w == nil {
		return 0
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	return len(w.entries)
}

// Bytes returns approximate serialized byte size of pending entries.
func (w *DecisionWAL) Bytes() int64 {
	if w == nil {
		return 0
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.bytes
}

// Append records a decision, assigning wal_seq. May drop oldest when over capacity.
func (w *DecisionWAL) Append(d Decision) error {
	if w == nil {
		return fmt.Errorf("nil WAL")
	}
	switch d.Action {
	case "allow", "deny", "passthrough":
	default:
		return fmt.Errorf("invalid action %q", d.Action)
	}
	if d.DecidedAt.IsZero() {
		d.DecidedAt = time.Now().UTC()
	} else {
		d.DecidedAt = d.DecidedAt.UTC()
	}

	w.mu.Lock()
	defer w.mu.Unlock()

	d.WalSeq = w.nextSeq
	w.nextSeq++
	size := estimateDecisionBytes(d)
	for w.bytes+size > w.maxBytes && len(w.entries) > 0 {
		if w.noDrop {
			w.nextSeq-- // roll back seq assignment
			return ErrWALFull
		}
		w.dropOldestLocked()
	}
	if w.bytes+size > w.maxBytes {
		if w.noDrop {
			w.nextSeq--
			return ErrWALFull
		}
		// single record larger than max — still accept after emptying
	}
	w.entries = append(w.entries, walEntry{rec: d, size: size})
	w.bytes += size
	w.publishBytesLocked()
	return w.persistLocked()
}

// Pending returns up to n oldest decisions (copy) without removing them.
func (w *DecisionWAL) Pending(n int) []Decision {
	if w == nil || n <= 0 {
		return nil
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	if n > len(w.entries) {
		n = len(w.entries)
	}
	out := make([]Decision, n)
	for i := 0; i < n; i++ {
		out[i] = w.entries[i].rec
	}
	return out
}

// AckThrough removes decisions with wal_seq <= seq after a successful flush.
func (w *DecisionWAL) AckThrough(seq int64) {
	if w == nil || seq <= 0 {
		return
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	i := 0
	for i < len(w.entries) && w.entries[i].rec.WalSeq <= seq {
		w.bytes -= w.entries[i].size
		i++
	}
	if i == 0 {
		return
	}
	w.entries = append([]walEntry(nil), w.entries[i:]...)
	if w.bytes < 0 {
		w.bytes = 0
	}
	w.publishBytesLocked()
	_ = w.persistLocked()
}

func (w *DecisionWAL) dropOldestLocked() {
	if len(w.entries) == 0 {
		return
	}
	w.bytes -= w.entries[0].size
	w.entries = w.entries[1:]
	if w.bytes < 0 {
		w.bytes = 0
	}
	if w.metrics != nil {
		w.metrics.DecisionsDropped.Add(1)
	}
}

func (w *DecisionWAL) publishBytes() {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.publishBytesLocked()
}

func (w *DecisionWAL) publishBytesLocked() {
	if w.metrics != nil {
		w.metrics.WALBytes.Store(w.bytes)
	}
}

func estimateDecisionBytes(d Decision) int64 {
	b, err := json.Marshal(d)
	if err != nil {
		return 256
	}
	return int64(len(b) + 1) // newline
}

type walDiskEnvelope struct {
	SchemaVersion int        `json:"schema_version"`
	NextSeq       int64      `json:"next_seq"`
	Decisions     []Decision `json:"decisions"`
}

func (w *DecisionWAL) load() error {
	data, err := os.ReadFile(w.path)
	if err != nil {
		return err
	}
	var env walDiskEnvelope
	if err := json.Unmarshal(data, &env); err != nil {
		return fmt.Errorf("wal load: %w", err)
	}
	if env.SchemaVersion != walSchemaVersion {
		return fmt.Errorf("unsupported wal schema_version %d", env.SchemaVersion)
	}
	w.entries = w.entries[:0]
	w.bytes = 0
	w.nextSeq = env.NextSeq
	if w.nextSeq <= 0 {
		w.nextSeq = 1
	}
	for _, d := range env.Decisions {
		size := estimateDecisionBytes(d)
		w.entries = append(w.entries, walEntry{rec: d, size: size})
		w.bytes += size
		if d.WalSeq >= w.nextSeq {
			w.nextSeq = d.WalSeq + 1
		}
	}
	return nil
}

func (w *DecisionWAL) persistLocked() error {
	if w.path == "" {
		return nil
	}
	env := walDiskEnvelope{
		SchemaVersion: walSchemaVersion,
		NextSeq:       w.nextSeq,
		Decisions:     make([]Decision, len(w.entries)),
	}
	for i, e := range w.entries {
		env.Decisions[i] = e.rec
	}
	data, err := json.Marshal(env)
	if err != nil {
		return err
	}
	dir := filepath.Dir(w.path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	tmp := w.path + ".tmp"
	f, err := os.OpenFile(tmp, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	if _, err := f.Write(data); err != nil {
		_ = f.Close()
		_ = os.Remove(tmp)
		return err
	}
	if err := f.Sync(); err != nil {
		_ = f.Close()
		_ = os.Remove(tmp)
		return err
	}
	if err := f.Close(); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	if err := os.Rename(tmp, w.path); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return syncDir(dir)
}

// NoDropWALMaxBytes applies the enterprise sizing floor (8 GiB) or an explicit override.
func NoDropWALMaxBytes(override int64) int64 {
	if override > 0 {
		return override
	}
	return defaultNoDropWALBytes
}

// SizedNoDropWALMaxBytes computes max(8GiB, ceil(p99BytesPerSec * outageSeconds * 1.5)).
func SizedNoDropWALMaxBytes(p99BytesPerSec float64, outageSeconds int) int64 {
	if outageSeconds <= 0 {
		outageSeconds = defaultOutageSeconds
	}
	if p99BytesPerSec < 0 {
		p99BytesPerSec = 0
	}
	calc := int64(p99BytesPerSec*float64(outageSeconds)*1.5 + 0.999999) // ceil
	if calc < defaultNoDropWALBytes {
		return defaultNoDropWALBytes
	}
	return calc
}
