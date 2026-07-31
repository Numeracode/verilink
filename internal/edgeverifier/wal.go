package edgeverifier

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"math"
	"os"
	"path/filepath"
	"sync"
	"time"
)

const (
	defaultWALMaxBytes    = 256 << 20 // 256 MiB
	defaultNoDropWALBytes = 8 << 30   // 8 GiB
	defaultOutageSeconds  = 900
	walSchemaVersion      = 2 // JSONL append-only (v1 was full-rewrite envelope)
	walSyncEveryN         = 32
	walMaxLineBytes       = 1 << 20 // 1 MiB per JSONL line
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
	mu           sync.Mutex
	path         string
	maxBytes     int64
	forcedNoDrop bool // sticky local override (CLI/env); never cleared by policy
	noDrop       bool // effective: forcedNoDrop || policy
	metrics      *Metrics

	nextSeq    int64
	entries    []walEntry
	bytes      int64
	file       *os.File
	sinceSync  int
	staleBytes int64 // bytes logically removed but still on disk until compact
}

type walEntry struct {
	rec  Decision
	size int64
}

type walLine struct {
	Type          string    `json:"t"` // meta|dec|ack
	SchemaVersion int       `json:"schema_version,omitempty"`
	NextSeq       int64     `json:"next_seq,omitempty"`
	Through       int64     `json:"through,omitempty"`
	WalSeq        int64     `json:"wal_seq,omitempty"`
	Fingerprint   string    `json:"fingerprint,omitempty"`
	PrincipalID   string    `json:"principal_id,omitempty"`
	Score         int       `json:"score,omitempty"`
	Blacklisted   bool      `json:"blacklisted,omitempty"`
	ScoreReason   string    `json:"score_reason,omitempty"`
	Action        string    `json:"action,omitempty"`
	DecidedAt     time.Time `json:"decided_at,omitempty"`
}

// WALConfig configures DecisionWAL.
type WALConfig struct {
	Path     string
	MaxBytes int64
	NoDrop   bool // sticky local override when true
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
		path:         cfg.Path,
		maxBytes:     maxBytes,
		forcedNoDrop: cfg.NoDrop,
		noDrop:       cfg.NoDrop,
		metrics:      cfg.Metrics,
		nextSeq:      1,
	}
	if cfg.Path != "" {
		if err := w.openAndLoad(); err != nil {
			return nil, err
		}
	}
	w.publishBytes()
	return w, nil
}

// SetNoDrop merges tenant policy into effective no-drop without clearing a local override.
// No-op when the effective value is unchanged (avoids hot-path contention).
func (w *DecisionWAL) SetNoDrop(v bool) {
	if w == nil {
		return
	}
	w.mu.Lock()
	next := w.forcedNoDrop || v
	if w.noDrop == next {
		w.mu.Unlock()
		return
	}
	w.noDrop = next
	w.mu.Unlock()
}

// ForcedNoDrop reports whether the local CLI/env override is set.
func (w *DecisionWAL) ForcedNoDrop() bool {
	if w == nil {
		return false
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.forcedNoDrop
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
	line := walLine{
		Type:        "dec",
		WalSeq:      d.WalSeq,
		Fingerprint: d.Fingerprint,
		PrincipalID: d.PrincipalID,
		Score:       d.Score,
		Blacklisted: d.Blacklisted,
		ScoreReason: d.ScoreReason,
		Action:      d.Action,
		DecidedAt:   d.DecidedAt,
	}
	encoded, err := json.Marshal(line)
	if err != nil {
		w.nextSeq--
		return err
	}
	encoded = append(encoded, '\n')
	if len(encoded) > walMaxLineBytes {
		w.nextSeq--
		return fmt.Errorf("wal line exceeds %d bytes", walMaxLineBytes)
	}
	size := int64(len(encoded))

	for w.bytes+size > w.maxBytes && len(w.entries) > 0 {
		if w.noDrop {
			w.nextSeq--
			return ErrWALFull
		}
		if err := w.dropOldestLocked(); err != nil {
			w.nextSeq--
			return err
		}
	}
	if w.bytes+size > w.maxBytes {
		w.nextSeq--
		return ErrWALFull
	}

	if err := w.writeBytesLocked(encoded, false); err != nil {
		w.nextSeq--
		return err
	}
	w.entries = append(w.entries, walEntry{rec: d, size: size})
	w.bytes += size
	w.publishBytesLocked()
	return w.maybeCompactLocked()
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
func (w *DecisionWAL) AckThrough(seq int64) error {
	if w == nil || seq <= 0 {
		return nil
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	i := 0
	var removed int64
	for i < len(w.entries) && w.entries[i].rec.WalSeq <= seq {
		removed += w.entries[i].size
		i++
	}
	if i == 0 {
		return nil
	}
	w.entries = append([]walEntry(nil), w.entries[i:]...)
	w.bytes -= removed
	if w.bytes < 0 {
		w.bytes = 0
	}
	w.staleBytes += removed
	if err := w.writeLineLocked(walLine{Type: "ack", Through: seq}, false); err != nil {
		return err
	}
	w.publishBytesLocked()
	return w.maybeCompactLocked()
}

func (w *DecisionWAL) dropOldestLocked() error {
	if len(w.entries) == 0 {
		return nil
	}
	droppedSeq := w.entries[0].rec.WalSeq
	removed := w.entries[0].size
	w.bytes -= removed
	w.staleBytes += removed
	w.entries = w.entries[1:]
	if w.bytes < 0 {
		w.bytes = 0
	}
	if w.metrics != nil {
		w.metrics.DecisionsDropped.Add(1)
	}
	// Persist drop via ack watermark (batched fsync — not per-drop force sync).
	return w.writeLineLocked(walLine{Type: "ack", Through: droppedSeq}, false)
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

func (w *DecisionWAL) openAndLoad() error {
	dir := filepath.Dir(w.path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	if err := w.loadStream(); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	f, err := os.OpenFile(w.path, os.O_CREATE|os.O_RDWR|os.O_APPEND, 0o600)
	if err != nil {
		return err
	}
	w.file = f
	info, err := f.Stat()
	if err != nil {
		return err
	}
	if info.Size() == 0 {
		return w.writeLineLocked(walLine{Type: "meta", SchemaVersion: walSchemaVersion, NextSeq: w.nextSeq}, true)
	}
	// Enforce capacity after reload once the file handle is open.
	for w.bytes > w.maxBytes && len(w.entries) > 0 {
		if w.noDrop {
			break
		}
		if err := w.dropOldestLocked(); err != nil {
			return err
		}
	}
	return nil
}

func (w *DecisionWAL) loadStream() error {
	f, err := os.Open(w.path)
	if err != nil {
		return err
	}
	defer f.Close()

	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 64<<10), walMaxLineBytes)

	pending := make(map[int64]Decision)
	var order []int64
	var ackThrough int64
	var sawMeta bool
	var tornTail error

	for sc.Scan() {
		raw := sc.Bytes()
		if len(raw) == 0 {
			continue
		}
		var line walLine
		if err := json.Unmarshal(raw, &line); err != nil {
			// Defer: if this is the final line, treat as crash-torn tail.
			if tornTail != nil {
				return fmt.Errorf("wal load line: %w", tornTail)
			}
			tornTail = err
			continue
		}
		if tornTail != nil {
			// A later valid line means the previous corrupt line was not a torn tail.
			return fmt.Errorf("wal load line: %w", tornTail)
		}
		switch line.Type {
		case "meta":
			if line.SchemaVersion != 0 && line.SchemaVersion != walSchemaVersion {
				return fmt.Errorf("unsupported wal schema_version %d", line.SchemaVersion)
			}
			sawMeta = true
			if line.NextSeq > w.nextSeq {
				w.nextSeq = line.NextSeq
			}
		case "dec":
			d := Decision{
				WalSeq:      line.WalSeq,
				Fingerprint: line.Fingerprint,
				PrincipalID: line.PrincipalID,
				Score:       line.Score,
				Blacklisted: line.Blacklisted,
				ScoreReason: line.ScoreReason,
				Action:      line.Action,
				DecidedAt:   line.DecidedAt,
			}
			if _, ok := pending[d.WalSeq]; !ok {
				order = append(order, d.WalSeq)
			}
			pending[d.WalSeq] = d
			if d.WalSeq >= w.nextSeq {
				w.nextSeq = d.WalSeq + 1
			}
		case "ack":
			if line.Through > ackThrough {
				ackThrough = line.Through
			}
		default:
			// ignore unknown for forward-compat
		}
	}
	if err := sc.Err(); err != nil {
		return err
	}
	if tornTail != nil {
		log.Printf("edgesync: ignoring torn trailing WAL line on recovery: %v", tornTail)
	}
	if !sawMeta && len(order) == 0 && ackThrough == 0 {
		return nil
	}

	w.entries = w.entries[:0]
	w.bytes = 0
	for _, seq := range order {
		if seq <= ackThrough {
			continue
		}
		d := pending[seq]
		size := estimateDecisionBytes(d)
		w.entries = append(w.entries, walEntry{rec: d, size: size})
		w.bytes += size
	}
	w.staleBytes = 0
	return nil
}

func (w *DecisionWAL) writeLineLocked(line walLine, forceSync bool) error {
	if w.path == "" {
		return nil
	}
	data, err := json.Marshal(line)
	if err != nil {
		return err
	}
	data = append(data, '\n')
	if len(data) > walMaxLineBytes {
		return fmt.Errorf("wal line exceeds %d bytes", walMaxLineBytes)
	}
	return w.writeBytesLocked(data, forceSync)
}

func (w *DecisionWAL) writeBytesLocked(data []byte, forceSync bool) error {
	if w.path == "" {
		return nil
	}
	if w.file == nil {
		return fmt.Errorf("wal file not open")
	}
	if _, err := w.file.Write(data); err != nil {
		return err
	}
	w.sinceSync++
	if forceSync || w.sinceSync >= walSyncEveryN {
		if err := w.file.Sync(); err != nil {
			return err
		}
		w.sinceSync = 0
	}
	return nil
}

func (w *DecisionWAL) maybeCompactLocked() error {
	if w.path == "" || w.file == nil {
		return nil
	}
	// Compact when discarded on-disk bytes are at least half of live bytes and ≥1 MiB.
	if w.staleBytes < 1<<20 {
		return nil
	}
	if w.bytes > 0 && w.staleBytes < w.bytes/2 {
		return nil
	}
	return w.compactLocked()
}

func (w *DecisionWAL) compactLocked() error {
	dir := filepath.Dir(w.path)
	tmp := w.path + ".compact"
	f, err := os.OpenFile(tmp, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	write := func(line walLine) error {
		b, err := json.Marshal(line)
		if err != nil {
			return err
		}
		b = append(b, '\n')
		if len(b) > walMaxLineBytes {
			return fmt.Errorf("wal line exceeds %d bytes", walMaxLineBytes)
		}
		_, err = f.Write(b)
		return err
	}
	if err := write(walLine{Type: "meta", SchemaVersion: walSchemaVersion, NextSeq: w.nextSeq}); err != nil {
		_ = f.Close()
		_ = os.Remove(tmp)
		return err
	}
	for _, e := range w.entries {
		d := e.rec
		if err := write(walLine{
			Type:        "dec",
			WalSeq:      d.WalSeq,
			Fingerprint: d.Fingerprint,
			PrincipalID: d.PrincipalID,
			Score:       d.Score,
			Blacklisted: d.Blacklisted,
			ScoreReason: d.ScoreReason,
			Action:      d.Action,
			DecidedAt:   d.DecidedAt,
		}); err != nil {
			_ = f.Close()
			_ = os.Remove(tmp)
			return err
		}
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

	// Keep the live fd open until the compacted file is renamed and re-opened so
	// Append never observes a nil handle mid-compact (mu is held for the whole swap).
	if err := os.Rename(tmp, w.path); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	dirErr := syncDir(dir)
	nf, err := os.OpenFile(w.path, os.O_CREATE|os.O_RDWR|os.O_APPEND, 0o600)
	if err != nil {
		// Path already points at compacted content; leave prior fd open as best effort.
		if dirErr != nil {
			return fmt.Errorf("wal compact reopen: %w (dir sync: %v)", err, dirErr)
		}
		return fmt.Errorf("wal compact reopen: %w", err)
	}
	prev := w.file
	w.file = nf
	if prev != nil {
		_ = prev.Close()
	}
	w.staleBytes = 0
	w.sinceSync = 0
	if dirErr != nil {
		return dirErr
	}
	return nil
}

func estimateDecisionBytes(d Decision) int64 {
	b, err := json.Marshal(d)
	if err != nil {
		return 256
	}
	return int64(len(b) + 1)
}

// Close flushes and closes the on-disk WAL handle.
func (w *DecisionWAL) Close() error {
	if w == nil {
		return nil
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.file == nil {
		return nil
	}
	err := w.file.Sync()
	cerr := w.file.Close()
	w.file = nil
	if err != nil {
		return err
	}
	return cerr
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
	calc := int64(math.Ceil(p99BytesPerSec * float64(outageSeconds) * 1.5))
	if calc < defaultNoDropWALBytes {
		return defaultNoDropWALBytes
	}
	return calc
}
