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
	defaultWALMaxAge      = 24 * time.Hour // PII/identifier retention bound independent of flush success
	walSchemaVersion      = 2              // JSONL append-only (v1 was full-rewrite envelope)
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
// Records are also age-bounded (default 24h) so PrincipalID/Fingerprint cannot linger
// indefinitely during a prolonged control-plane outage.
type DecisionWAL struct {
	mu           sync.Mutex
	path         string
	maxBytes     int64
	maxAge       time.Duration
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
	// MaxAge is the on-disk retention window for decision identifiers (default 24h).
	// Zero selects the default; negative disables age pruning (tests only).
	MaxAge  time.Duration
	NoDrop  bool // sticky local override when true
	Metrics *Metrics
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
	maxAge := cfg.MaxAge
	if maxAge == 0 {
		maxAge = defaultWALMaxAge
	}
	w := &DecisionWAL{
		path:         cfg.Path,
		maxBytes:     maxBytes,
		maxAge:       maxAge,
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

// MaxAge returns the retention window for decision records.
func (w *DecisionWAL) MaxAge() time.Duration {
	if w == nil {
		return 0
	}
	return w.maxAge
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

	if err := w.pruneExpiredLocked(time.Now().UTC()); err != nil {
		return err
	}

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

	if err := w.dropForCapacityLocked(size); err != nil {
		w.nextSeq--
		return err
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

// removeOldestLocked drops the oldest in-memory entry without writing disk.
// Callers that drop multiple entries should write a single coalesced ack afterward.
func (w *DecisionWAL) removeOldestLocked() (droppedSeq int64, ok bool) {
	if len(w.entries) == 0 {
		return 0, false
	}
	droppedSeq = w.entries[0].rec.WalSeq
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
	return droppedSeq, true
}

// compactEntriesLocked reallocates when head-slicing left substantial unused capacity.
func (w *DecisionWAL) compactEntriesLocked() {
	n := len(w.entries)
	if n == 0 {
		w.entries = nil
		return
	}
	if cap(w.entries) >= 64 && cap(w.entries) >= 2*n {
		w.entries = append([]walEntry(nil), w.entries...)
	}
}

// dropForCapacityLocked removes oldest entries until bytes+need fits, writing one ack.
func (w *DecisionWAL) dropForCapacityLocked(need int64) error {
	var lastDropped int64
	dropped := false
	for w.bytes+need > w.maxBytes && len(w.entries) > 0 {
		if w.noDrop {
			return ErrWALFull
		}
		seq, ok := w.removeOldestLocked()
		if !ok {
			break
		}
		lastDropped = seq
		dropped = true
	}
	if dropped {
		w.compactEntriesLocked()
		if err := w.writeLineLocked(walLine{Type: "ack", Through: lastDropped}, false); err != nil {
			return err
		}
	}
	if w.bytes+need > w.maxBytes {
		return ErrWALFull
	}
	return nil
}

// pruneExpiredLocked drops decisions older than maxAge. Age retention applies even
// under no-drop so identifier data cannot linger past the configured window.
func (w *DecisionWAL) pruneExpiredLocked(now time.Time) error {
	if w.maxAge < 0 {
		return nil
	}
	cutoff := now.Add(-w.maxAge)
	var lastDropped int64
	dropped := false
	for len(w.entries) > 0 {
		if !w.entries[0].rec.DecidedAt.Before(cutoff) {
			break
		}
		seq, ok := w.removeOldestLocked()
		if !ok {
			break
		}
		lastDropped = seq
		dropped = true
	}
	if !dropped {
		return nil
	}
	w.compactEntriesLocked()
	return w.writeLineLocked(walLine{Type: "ack", Through: lastDropped}, false)
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
	if err := w.pruneExpiredLocked(time.Now().UTC()); err != nil {
		return err
	}
	// Enforce capacity after reload once the file handle is open.
	if w.noDrop && w.bytes > w.maxBytes {
		return fmt.Errorf("wal loaded %d bytes exceeds no-drop limit %d; drain or raise VERILINK_WAL_MAX_BYTES", w.bytes, w.maxBytes)
	}
	return w.dropForCapacityLocked(0)
}

func (w *DecisionWAL) loadStream() error {
	ackThrough, nextSeq, err := w.scanWALWatermarks()
	if err != nil {
		return err
	}
	w.nextSeq = nextSeq

	f, err := os.Open(w.path)
	if err != nil {
		return err
	}
	defer f.Close()

	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 64<<10), walMaxLineBytes)

	var sawMeta bool
	var tornTail error

	w.entries = w.entries[:0]
	w.bytes = 0

	for sc.Scan() {
		raw := sc.Bytes()
		if len(raw) == 0 {
			continue
		}
		var line walLine
		if err := json.Unmarshal(raw, &line); err != nil {
			if tornTail != nil {
				return fmt.Errorf("wal load line: %w", tornTail)
			}
			tornTail = err
			continue
		}
		if tornTail != nil {
			return fmt.Errorf("wal load line: %w", tornTail)
		}
		switch line.Type {
		case "meta":
			if line.SchemaVersion != 0 && line.SchemaVersion != walSchemaVersion {
				return fmt.Errorf("unsupported wal schema_version %d", line.SchemaVersion)
			}
			sawMeta = true
		case "dec":
			if line.WalSeq <= ackThrough {
				continue
			}
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
			size := estimateDecisionBytes(d)
			w.entries = append(w.entries, walEntry{rec: d, size: size})
			w.bytes += size
		case "ack":
			// Ack watermark already applied via first pass.
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
	if !sawMeta && len(w.entries) == 0 && ackThrough == 0 {
		return nil
	}
	w.staleBytes = 0
	return nil
}

// scanWALWatermarks reads the WAL once for ackThrough and nextSeq without retaining
// acknowledged decision payloads in memory.
func (w *DecisionWAL) scanWALWatermarks() (ackThrough, nextSeq int64, err error) {
	f, err := os.Open(w.path)
	if err != nil {
		return 0, 0, err
	}
	defer f.Close()

	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 64<<10), walMaxLineBytes)
	nextSeq = 1
	var tornTail error
	for sc.Scan() {
		raw := sc.Bytes()
		if len(raw) == 0 {
			continue
		}
		var line walLine
		if err := json.Unmarshal(raw, &line); err != nil {
			if tornTail != nil {
				return 0, 0, fmt.Errorf("wal load line: %w", tornTail)
			}
			tornTail = err
			continue
		}
		if tornTail != nil {
			return 0, 0, fmt.Errorf("wal load line: %w", tornTail)
		}
		switch line.Type {
		case "meta":
			if line.NextSeq > nextSeq {
				nextSeq = line.NextSeq
			}
		case "dec":
			if line.WalSeq >= nextSeq {
				nextSeq = line.WalSeq + 1
			}
		case "ack":
			if line.Through > ackThrough {
				ackThrough = line.Through
			}
		}
	}
	if err := sc.Err(); err != nil {
		return 0, 0, err
	}
	return ackThrough, nextSeq, nil
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
	want := math.Ceil(p99BytesPerSec * float64(outageSeconds) * 1.5)
	if want >= float64(math.MaxInt64) {
		return math.MaxInt64
	}
	calc := int64(want)
	if calc < defaultNoDropWALBytes {
		return defaultNoDropWALBytes
	}
	return calc
}
