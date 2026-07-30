package edgeverifier

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"strconv"
	"strings"
	"sync/atomic"
	"time"
)

const (
	defaultRetryMs   = 5000
	maxBackoffMs     = 30000
	snapshotFetchTO  = 30 * time.Second
	sseIdleTimeout   = 90 * time.Second // 3× Plan 7 30s heartbeat
	maxSSELineBytes  = 256 << 10        // 256 KiB
	maxSSEEventBytes = 1 << 20          // 1 MiB assembled data
)

// SyncRunner bootstraps from disk/CP snapshot and maintains the SSE sync loop.
type SyncRunner struct {
	Client       *ControlPlaneClient
	Store        *Store
	SnapshotPath string
	Logger       *log.Logger
	OnReachable  func(bool)
	Metrics      *Metrics

	persistEveryEvents  int
	persistEvery        time.Duration
	durableSincePersist int
	lastPersist         time.Time
}

// SyncRunnerOption configures SyncRunner.
type SyncRunnerOption func(*SyncRunner)

// WithPersistCadence sets disk persist cadence (defaults: 100 events or 60s).
func WithPersistCadence(everyEvents int, every time.Duration) SyncRunnerOption {
	return func(r *SyncRunner) {
		r.persistEveryEvents = everyEvents
		r.persistEvery = every
	}
}

// WithOnReachable sets a callback invoked when SSE session reachability changes.
func WithOnReachable(fn func(bool)) SyncRunnerOption {
	return func(r *SyncRunner) {
		r.OnReachable = fn
	}
}

// WithMetrics attaches edge metrics (reconnect counters, store gauges).
func WithMetrics(m *Metrics) SyncRunnerOption {
	return func(r *SyncRunner) {
		r.Metrics = m
	}
}

// NewSyncRunner builds a runner. SnapshotPath may be empty to skip disk I/O.
func NewSyncRunner(client *ControlPlaneClient, store *Store, snapshotPath string, opts ...SyncRunnerOption) *SyncRunner {
	r := &SyncRunner{
		Client:             client,
		Store:              store,
		SnapshotPath:       snapshotPath,
		Logger:             log.Default(),
		persistEveryEvents: 100,
		persistEvery:       60 * time.Second,
	}
	for _, o := range opts {
		o(r)
	}
	return r
}

func (r *SyncRunner) setReachable(ok bool) {
	if r.OnReachable != nil {
		r.OnReachable(ok)
	}
}

// Bootstrap loads disk snapshot if present, else fetches from control plane.
func (r *SyncRunner) Bootstrap(ctx context.Context) error {
	if r.SnapshotPath != "" {
		if snap, err := LoadSnapshot(r.SnapshotPath); err == nil {
			ApplySnapshot(r.Store, snap)
			r.lastPersist = time.Now()
			r.logf("loaded disk snapshot hw=%d", r.Store.HighWater())
			return nil
		}
	}
	fetchCtx, cancel := context.WithTimeout(ctx, snapshotFetchTO)
	defer cancel()
	snap, err := r.Client.FetchSnapshot(fetchCtx)
	if err != nil {
		return fmt.Errorf("fetch snapshot: %w", err)
	}
	ApplySnapshot(r.Store, snap)
	if err := r.persist(r.Store.SnapshotForPersist()); err != nil {
		r.logf("persist after bootstrap: %v", err)
	}
	r.logf("fetched snapshot hw=%d", r.Store.HighWater())
	return nil
}

// Run bootstraps (if store empty) then reconnects SSE until ctx is cancelled.
func (r *SyncRunner) Run(ctx context.Context) error {
	if r.Store.Load() == nil {
		if err := r.Bootstrap(ctx); err != nil {
			return err
		}
	}
	backoffMs := defaultRetryMs
	for {
		if ctx.Err() != nil {
			r.setReachable(false)
			return ctx.Err()
		}
		retryMs, err := r.runSession(ctx)
		r.setReachable(false)
		if r.Metrics != nil {
			r.Metrics.ObserveStore(r.Store)
			r.Metrics.IncSyncReconnect(reconnectReason(err))
		}
		// Only adopt server-provided retry:; otherwise preserve exponential backoff.
		if retryMs > 0 {
			backoffMs = minInt(retryMs, maxBackoffMs)
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if err != nil {
			r.logf("sse session ended: %v; reconnect in %dms", err, backoffMs)
		} else {
			r.logf("sse session ended; reconnect in %dms", backoffMs)
		}
		timer := time.NewTimer(time.Duration(backoffMs) * time.Millisecond)
		select {
		case <-ctx.Done():
			timer.Stop()
			return ctx.Err()
		case <-timer.C:
		}
		backoffMs = minInt(backoffMs*2, maxBackoffMs)
	}
}

func (r *SyncRunner) runSession(ctx context.Context) (retryMs int, err error) {
	cursor := r.Store.HighWater()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, r.Client.base()+"/v1/sync/events", nil)
	if err != nil {
		return 0, err
	}
	req.Header.Set("Authorization", "Bearer "+r.Client.APIKey)
	req.Header.Set("Accept", "text/event-stream")
	req.Header.Set("Last-Event-ID", strconv.FormatInt(cursor, 10))

	resp, err := r.Client.http().Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()

	switch resp.StatusCode {
	case http.StatusOK:
		r.setReachable(true)
	case http.StatusTooManyRequests, http.StatusGone:
		r.logf("sync recovery status=%d — refetch snapshot", resp.StatusCode)
		if err := r.recoverSnapshot(ctx); err != nil {
			return 0, err
		}
		return 0, fmt.Errorf("recovered from %d", resp.StatusCode)
	case http.StatusServiceUnavailable:
		return 0, fmt.Errorf("sse unavailable: %d", resp.StatusCode)
	default:
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return 0, fmt.Errorf("sse status %d: %s", resp.StatusCode, truncate(string(body), 200))
	}

	return r.readStream(ctx, resp.Body)
}

func (r *SyncRunner) recoverSnapshot(ctx context.Context) error {
	snapCtx, cancel := context.WithTimeout(ctx, snapshotFetchTO)
	defer cancel()
	snap, err := r.Client.FetchSnapshot(snapCtx)
	if err != nil {
		return err
	}
	ApplySnapshot(r.Store, snap)
	return r.persist(r.Store.SnapshotForPersist())
}

func (r *SyncRunner) readStream(ctx context.Context, body io.ReadCloser) (retryMs int, err error) {
	retryMs = 0
	var lastActivity atomic.Int64
	lastActivity.Store(time.Now().UnixNano())
	stopIdle := startIdleWatchdog(ctx, body, &lastActivity)
	defer stopIdle()

	touch := func() {
		lastActivity.Store(time.Now().UnixNano())
		r.Store.NoteBytes()
	}
	frame := &sseFrame{runner: r, touch: touch}
	br := bufio.NewReaderSize(body, maxSSELineBytes+1)

	for {
		if ctx.Err() != nil {
			return retryMs, ctx.Err()
		}
		line, err := readSSELine(br)
		if err != nil {
			if err == io.EOF {
				if line != "" {
					if derr := frame.dispatch(line, &retryMs); derr != nil {
						return retryMs, derr
					}
				}
				if ferr := frame.flush(); ferr != nil {
					return retryMs, ferr
				}
				return retryMs, io.EOF
			}
			return retryMs, err
		}
		if derr := frame.dispatch(line, &retryMs); derr != nil {
			return retryMs, derr
		}
	}
}

func startIdleWatchdog(ctx context.Context, body io.Closer, lastActivity *atomic.Int64) func() {
	idleCtx, idleCancel := context.WithCancel(ctx)
	go func() {
		t := time.NewTicker(5 * time.Second)
		defer t.Stop()
		for {
			select {
			case <-idleCtx.Done():
				return
			case <-t.C:
				last := time.Unix(0, lastActivity.Load())
				if time.Since(last) > sseIdleTimeout {
					_ = body.Close()
					return
				}
			}
		}
	}()
	return idleCancel
}

type sseFrame struct {
	runner    *SyncRunner
	touch     func()
	eventName string
	idStr     string
	dataLines []string
	dataBytes int
}

func (f *sseFrame) reset() {
	f.eventName, f.idStr, f.dataLines, f.dataBytes = "", "", nil, 0
}

func (f *sseFrame) flush() error {
	defer f.reset()
	data := strings.Join(f.dataLines, "\n")
	f.touch()

	switch f.eventName {
	case "":
		return nil
	case "shutdown":
		return fmt.Errorf("shutdown")
	case "cursor":
		hw, perr := parseID(f.idStr)
		if perr != nil {
			f.runner.logf("ignore cursor with bad id %q: %v", f.idStr, perr)
			return nil
		}
		AdvanceCursor(f.runner.Store, hw)
		return nil
	default:
		hw, perr := parseID(f.idStr)
		if perr != nil || hw <= 0 {
			f.runner.logf("ignore %s with bad id %q: %v", f.eventName, f.idStr, perr)
			return nil
		}
		if err := ApplyEvent(f.runner.Store, hw, f.eventName, json.RawMessage(data)); err != nil {
			return fmt.Errorf("apply %s id=%d: %w", f.eventName, hw, err)
		}
		f.runner.durableSincePersist++
		f.runner.maybePersist()
		return nil
	}
}

func (f *sseFrame) dispatch(line string, retryMs *int) error {
	f.touch()
	if line == "" {
		return f.flush()
	}
	if strings.HasPrefix(line, ":") {
		return nil
	}
	if strings.HasPrefix(line, "retry:") {
		if v, ok := parseRetryMs(strings.TrimSpace(line[len("retry:"):])); ok {
			*retryMs = v
		}
		return nil
	}
	if strings.HasPrefix(line, "event:") {
		f.eventName = strings.TrimSpace(line[len("event:"):])
		return nil
	}
	if strings.HasPrefix(line, "id:") {
		f.idStr = strings.TrimSpace(line[len("id:"):])
		return nil
	}
	if strings.HasPrefix(line, "data:") {
		payload := strings.TrimSpace(line[len("data:"):])
		next := f.dataBytes + len(payload) + 1
		if next > maxSSEEventBytes {
			return fmt.Errorf("sse event exceeds %d bytes", maxSSEEventBytes)
		}
		f.dataLines = append(f.dataLines, payload)
		f.dataBytes = next
	}
	return nil
}

func readSSELine(br *bufio.Reader) (string, error) {
	var buf []byte
	for {
		chunk, err := br.ReadSlice('\n')
		if len(buf)+len(chunk) > maxSSELineBytes {
			return "", fmt.Errorf("sse line exceeds %d bytes", maxSSELineBytes)
		}
		if err == nil {
			buf = append(buf, chunk...)
			return strings.TrimRight(string(buf), "\r\n"), nil
		}
		if err == bufio.ErrBufferFull {
			buf = append(buf, chunk...)
			continue
		}
		if err == io.EOF {
			if len(buf) == 0 && len(chunk) == 0 {
				return "", io.EOF
			}
			buf = append(buf, chunk...)
			return strings.TrimRight(string(buf), "\r\n"), io.EOF
		}
		return "", err
	}
}

func (r *SyncRunner) maybePersist() {
	if r.SnapshotPath == "" {
		return
	}
	dueEvents := r.persistEveryEvents > 0 && r.durableSincePersist >= r.persistEveryEvents
	dueTime := r.persistEvery > 0 && time.Since(r.lastPersist) >= r.persistEvery
	if !dueEvents && !dueTime {
		return
	}
	if err := r.persist(r.Store.SnapshotForPersist()); err != nil {
		r.logf("persist: %v", err)
	}
}

func (r *SyncRunner) persist(snap *Snapshot) error {
	if r.SnapshotPath == "" || snap == nil {
		return nil
	}
	if err := SaveSnapshot(r.SnapshotPath, snap); err != nil {
		return err
	}
	r.durableSincePersist = 0
	r.lastPersist = time.Now()
	return nil
}

func (r *SyncRunner) logf(format string, args ...any) {
	if r.Logger != nil {
		r.Logger.Printf("edgesync: "+format, args...)
	}
}

func parseRetryMs(s string) (int, bool) {
	s = strings.TrimSpace(s)
	if s == "" {
		return 0, false
	}
	n, err := strconv.Atoi(s)
	if err != nil || n <= 0 {
		return 0, false
	}
	if n > maxBackoffMs {
		n = maxBackoffMs
	}
	return n, true
}

func parseID(s string) (int64, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return 0, fmt.Errorf("empty id")
	}
	return strconv.ParseInt(s, 10, 64)
}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}

func reconnectReason(err error) string {
	if err == nil {
		return "eof"
	}
	msg := err.Error()
	switch {
	case strings.Contains(msg, "shutdown"):
		return "shutdown"
	case strings.Contains(msg, "recovered from 429"):
		return "backlog"
	case strings.Contains(msg, "recovered from 410"):
		return "gone"
	case strings.Contains(msg, "unavailable"):
		return "unavailable"
	case errors.Is(err, context.Canceled), errors.Is(err, context.DeadlineExceeded):
		return "canceled"
	default:
		return "error"
	}
}
