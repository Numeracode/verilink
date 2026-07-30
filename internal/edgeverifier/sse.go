package edgeverifier

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"
)

const (
	defaultRetryMs = 5000
	maxBackoffMs   = 30000
)

// SyncRunner bootstraps from disk/CP snapshot and maintains the SSE sync loop.
type SyncRunner struct {
	Client       *ControlPlaneClient
	Store        *Store
	SnapshotPath string
	Logger       *log.Logger

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

// Bootstrap loads disk snapshot if present, else fetches from control plane.
func (r *SyncRunner) Bootstrap(ctx context.Context) error {
	if r.SnapshotPath != "" {
		if snap, err := LoadSnapshot(r.SnapshotPath); err == nil {
			ApplySnapshot(r.Store, snap)
			r.lastPersist = time.Now()
			r.logf("loaded disk snapshot hw=%d", snap.HighWaterVersion)
			return nil
		}
	}
	snap, err := r.Client.FetchSnapshot(ctx)
	if err != nil {
		return fmt.Errorf("fetch snapshot: %w", err)
	}
	ApplySnapshot(r.Store, snap)
	if err := r.persist(snap); err != nil {
		r.logf("persist after bootstrap: %v", err)
	}
	r.logf("fetched snapshot hw=%d", snap.HighWaterVersion)
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
			return ctx.Err()
		}
		retryMs, err := r.runSession(ctx)
		if retryMs > 0 {
			backoffMs = retryMs
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
	retryMs = defaultRetryMs
	cursor := r.Store.HighWater()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, r.Client.base()+"/v1/sync/events", nil)
	if err != nil {
		return retryMs, err
	}
	req.Header.Set("Authorization", "Bearer "+r.Client.APIKey)
	req.Header.Set("Accept", "text/event-stream")
	req.Header.Set("Last-Event-ID", strconv.FormatInt(cursor, 10))

	resp, err := r.Client.http().Do(req)
	if err != nil {
		return retryMs, err
	}
	defer resp.Body.Close()

	switch resp.StatusCode {
	case http.StatusOK:
		// stream
	case http.StatusTooManyRequests, http.StatusGone:
		r.logf("sync recovery status=%d — refetch snapshot", resp.StatusCode)
		if err := r.recoverSnapshot(ctx); err != nil {
			return retryMs, err
		}
		return retryMs, fmt.Errorf("recovered from %d", resp.StatusCode)
	case http.StatusServiceUnavailable:
		return retryMs, fmt.Errorf("sse unavailable: %d", resp.StatusCode)
	default:
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return retryMs, fmt.Errorf("sse status %d: %s", resp.StatusCode, truncate(string(body), 200))
	}

	return r.readStream(ctx, resp.Body)
}

func (r *SyncRunner) recoverSnapshot(ctx context.Context) error {
	snap, err := r.Client.FetchSnapshot(ctx)
	if err != nil {
		return err
	}
	ApplySnapshot(r.Store, snap)
	return r.persist(snap)
}

func (r *SyncRunner) readStream(ctx context.Context, body io.Reader) (retryMs int, err error) {
	retryMs = defaultRetryMs
	br := bufio.NewReader(body)
	var (
		eventName string
		idStr     string
		dataLines []string
	)
	flush := func() error {
		defer func() {
			eventName, idStr, dataLines = "", "", nil
		}()
		data := strings.Join(dataLines, "\n")
		r.Store.NoteBytes()

		switch eventName {
		case "":
			return nil
		case "shutdown":
			return fmt.Errorf("shutdown")
		case "cursor":
			hw, perr := parseID(idStr)
			if perr == nil {
				AdvanceCursor(r.Store, hw)
			}
			return nil
		default:
			hw, _ := parseID(idStr)
			if err := ApplyEvent(r.Store, hw, eventName, json.RawMessage(data)); err != nil {
				r.logf("apply %s: %v", eventName, err)
				return nil
			}
			r.durableSincePersist++
			r.maybePersist()
			return nil
		}
	}

	for {
		if ctx.Err() != nil {
			return retryMs, ctx.Err()
		}
		line, err := br.ReadString('\n')
		if err != nil {
			if err == io.EOF {
				_ = flush()
				return retryMs, io.EOF
			}
			return retryMs, err
		}
		line = strings.TrimRight(line, "\r\n")

		if line == "" {
			if err := flush(); err != nil {
				return retryMs, err
			}
			continue
		}
		if strings.HasPrefix(line, ":") {
			r.Store.NoteBytes() // ping / comment
			continue
		}
		if strings.HasPrefix(line, "retry:") {
			if v, ok := parseRetryMs(strings.TrimSpace(line[len("retry:"):])); ok {
				retryMs = v
			}
			continue
		}
		if strings.HasPrefix(line, "event:") {
			eventName = strings.TrimSpace(line[len("event:"):])
			continue
		}
		if strings.HasPrefix(line, "id:") {
			idStr = strings.TrimSpace(line[len("id:"):])
			continue
		}
		if strings.HasPrefix(line, "data:") {
			dataLines = append(dataLines, strings.TrimSpace(line[len("data:"):]))
			continue
		}
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
	snap := r.Store.Load()
	if snap == nil {
		return
	}
	if err := r.persist(snap); err != nil {
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
