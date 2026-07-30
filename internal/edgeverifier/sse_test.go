package edgeverifier

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"sync/atomic"
	"testing"
	"time"
)

func TestSSEShutdownAndCursor(t *testing.T) {
	var eventSessions atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v1/sync/snapshot" {
			_ = json.NewEncoder(w).Encode(map[string]any{
				"ok": true,
				"data": map[string]any{
					"highWaterVersion": 0,
					"scores":           []any{},
					"keys":             []any{},
				},
			})
			return
		}
		if r.URL.Path != "/v1/sync/events" {
			http.NotFound(w, r)
			return
		}
		n := int(eventSessions.Add(1))
		w.Header().Set("Content-Type", "text/event-stream")
		flusher, _ := w.(http.Flusher)
		fmt.Fprintf(w, "retry: 100\n\n")
		fmt.Fprintf(w, "event: cursor\nid: 2\ndata: {}\n\n")
		if flusher != nil {
			flusher.Flush()
		}
		if n == 1 {
			fmt.Fprintf(w, "event: shutdown\ndata: {}\n\n")
			if flusher != nil {
				flusher.Flush()
			}
			return
		}
		// second session: hang until client cancels
		<-r.Context().Done()
	}))
	defer srv.Close()

	store := NewStore()
	client := &ControlPlaneClient{BaseURL: srv.URL, APIKey: "vrl_test", HTTPClient: srv.Client()}
	runner := NewSyncRunner(client, store, "", WithPersistCadence(1000, time.Hour))
	runner.Logger = nil

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	done := make(chan error, 1)
	go func() { done <- runner.Run(ctx) }()

	deadline := time.Now().Add(1500 * time.Millisecond)
	for time.Now().Before(deadline) {
		if store.HighWater() >= 2 && eventSessions.Load() >= 2 {
			cancel()
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if store.HighWater() < 2 {
		t.Fatalf("expected cursor advance, hw=%d sessions=%d", store.HighWater(), eventSessions.Load())
	}
	if eventSessions.Load() < 2 {
		t.Fatalf("expected reconnect after shutdown, sessions=%d", eventSessions.Load())
	}
	<-done
}

func TestSSE429RecoversViaSnapshot(t *testing.T) {
	var n atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/sync/snapshot":
			n.Add(1)
			hw := 7
			_ = json.NewEncoder(w).Encode(map[string]any{
				"ok": true,
				"data": map[string]any{
					"highWaterVersion": hw,
					"scores": []map[string]any{{
						"principal_id": "p1",
						"entity_kind":  "agent",
						"score":        88,
						"blacklisted":  false,
						"score_reason": "ok",
					}},
					"keys": []any{},
				},
			})
		case "/v1/sync/events":
			if r.Header.Get("Last-Event-ID") == "0" || r.Header.Get("Last-Event-ID") == "" {
				w.Header().Set("X-Verilink-Sync-Reason", "backlog-cap")
				http.Error(w, "backlog", http.StatusTooManyRequests)
				return
			}
			// after recovery Last-Event-ID should be 7
			if r.Header.Get("Last-Event-ID") != strconv.Itoa(7) {
				http.Error(w, "bad cursor "+r.Header.Get("Last-Event-ID"), http.StatusBadRequest)
				return
			}
			w.Header().Set("Content-Type", "text/event-stream")
			fmt.Fprintf(w, "retry: 50\n\n")
			fmt.Fprintf(w, "event: shutdown\ndata: {}\n\n")
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	store := NewStore()
	ApplySnapshot(store, &Snapshot{HighWaterVersion: 0, Scores: map[string]ScoreEntry{}, Keys: map[string]KeyEntry{}})
	client := &ControlPlaneClient{BaseURL: srv.URL, APIKey: "k", HTTPClient: srv.Client()}
	runner := NewSyncRunner(client, store, "")
	runner.Logger = nil

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	go func() { _ = runner.Run(ctx) }()

	deadline := time.Now().Add(1500 * time.Millisecond)
	for time.Now().Before(deadline) {
		if store.HighWater() == 7 {
			e, ok := store.LookupScore("p1")
			if ok && e.Score == 88 {
				cancel()
				return
			}
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("429 recovery failed hw=%d n=%d", store.HighWater(), n.Load())
}
