package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"sync"
	"syscall"
	"time"

	"github.com/messagesgoel-blip/verilink/internal/edgeverifier"
	"github.com/messagesgoel-blip/verilink/pkg/fingerprint"
	"github.com/messagesgoel-blip/verilink/pkg/requestsigin"
	"github.com/messagesgoel-blip/verilink/pkg/verifier"
)

type edgeConfig struct {
	externalBaseURL   string
	agentKeysPath     string
	requireSignatures bool
	controlPlaneURL   string
	apiKey            string
	snapshotPath      string
	walPath           string
	walMaxBytes       int64
	walMaxAge         time.Duration
	noDropDecisions   bool
	syncEnabled       bool
}

func main() {
	cfg := parseFlags()
	ts, registry, nonceCache := bootstrapDemoIdentity(cfg.agentKeysPath)
	defer nonceCache.Stop()

	metrics := edgeverifier.NewMetrics()
	decisionWAL := mustOpenWAL(cfg, metrics)

	var (
		snapStore   *edgeverifier.Store
		syncCancel  context.CancelFunc
		syncCtx     context.Context
		syncRunner  *edgeverifier.SyncRunner
		flushCancel context.CancelFunc
		bg          sync.WaitGroup
	)
	if cfg.syncEnabled {
		snapStore, syncRunner, syncCtx, syncCancel = mustStartSync(cfg, metrics, decisionWAL)
	}

	backendServer := startMockBackend()
	proxy, err := edgeverifier.NewEdgeVerifierProxyFull(
		"http://localhost:8081", ts, registry, nonceCache, cfg.requireSignatures, cfg.externalBaseURL, snapStore, decisionWAL, metrics,
	)
	if err != nil {
		log.Fatal(err)
	}

	if decisionWAL != nil {
		var flushCtx context.Context
		flushCtx, flushCancel = context.WithCancel(context.Background())
		worker := edgeverifier.NewFlushWorker(decisionWAL, &edgeverifier.StubTransport{Logger: log.Default()})
		bg.Add(1)
		go func() {
			defer bg.Done()
			worker.Run(flushCtx)
		}()
	}

	if syncRunner != nil {
		syncRunner.OnReachable = proxy.SetSyncReachable
		bg.Add(1)
		go func() {
			defer bg.Done()
			if err := syncRunner.Run(syncCtx); err != nil && syncCtx.Err() == nil {
				log.Printf("sync runner stopped: %v", err)
			}
		}()
	}

	log.Println("Verilink Edge Verifier running on :8080")
	server := &http.Server{
		Addr:              ":8080",
		Handler:           proxy,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      10 * time.Second,
		IdleTimeout:       60 * time.Second,
	}

	bg.Add(1)
	go func() {
		defer bg.Done()
		sigCh := make(chan os.Signal, 1)
		signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
		<-sigCh
		log.Printf("shutting down…")
		if syncCancel != nil {
			syncCancel()
		}
		if flushCancel != nil {
			flushCancel()
		}
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = server.Shutdown(shutdownCtx)
		_ = backendServer.Shutdown(shutdownCtx)
	}()

	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatal(err)
	}
	bg.Wait()
	if decisionWAL != nil {
		if err := decisionWAL.Close(); err != nil {
			log.Printf("decision WAL close: %v", err)
			os.Exit(1)
		}
	}
}

func parseFlags() edgeConfig {
	var cfg edgeConfig
	flag.StringVar(&cfg.externalBaseURL, "external-base-url", "", "Base URL for @target-uri construction (mandatory behind a TLS-terminating proxy)")
	flag.StringVar(&cfg.agentKeysPath, "agent-keys-path", "", "Path to agent keys JSON file (demo/bootstrap; synced keys win when sync enabled)")
	flag.BoolVar(&cfg.requireSignatures, "require-signatures", false, "Require RFC 9421 signatures on all requests")
	flag.StringVar(&cfg.controlPlaneURL, "control-plane-url", envOr("VERILINK_CONTROL_PLANE_URL", ""), "Control plane base URL")
	flag.StringVar(&cfg.snapshotPath, "snapshot-path", envOr("VERILINK_SNAPSHOT_PATH", ""), "On-disk snapshot path")
	flag.StringVar(&cfg.walPath, "wal-path", envOr("VERILINK_WAL_PATH", ""), "On-disk decision WAL path")
	flag.Int64Var(&cfg.walMaxBytes, "wal-max-bytes", envInt64("VERILINK_WAL_MAX_BYTES", 0), "Decision WAL max bytes (0 = default 256MiB or 8GiB when no-drop)")
	flag.DurationVar(&cfg.walMaxAge, "wal-max-age", envDuration("VERILINK_WAL_MAX_AGE", 0), "Decision WAL retention window (0 = default 24h; drops identifiers even under no-drop)")
	flag.BoolVar(&cfg.noDropDecisions, "no-drop-decisions", envBool("VERILINK_NO_DROP_DECISIONS", false), "Block when WAL full instead of dropping oldest")
	flag.BoolVar(&cfg.syncEnabled, "sync", false, "Enable control-plane sync (also true when URL+key set unless VERILINK_SYNC_ENABLED=false)")
	flag.Parse()

	cfg.apiKey = os.Getenv("VERILINK_API_KEY")
	if v := os.Getenv("VERILINK_SYNC_ENABLED"); v == "false" || v == "0" {
		cfg.syncEnabled = false
	} else if cfg.controlPlaneURL != "" && cfg.apiKey != "" {
		cfg.syncEnabled = true
	}
	return cfg
}

func bootstrapDemoIdentity(agentKeysPath string) (verifier.TrustStore, *requestsigin.AgentRegistry, *requestsigin.NonceCache) {
	ts := verifier.NewMockTrustStore()
	trustedData := fingerprint.RequestData{
		JA4:      "test-ja4",
		Protocol: "HTTP/1.1",
		Headers:  map[string]string{"User-Agent": "TestAgent"},
	}
	trustedFP, err := fingerprint.Generate(trustedData)
	if err != nil {
		log.Fatalf("Failed to generate trusted fingerprint: %v", err)
	}
	if seedErr := ts.SetTrustScore(trustedFP, 100); seedErr != nil {
		log.Fatalf("Failed to seed trusted fingerprint: %v", seedErr)
	}
	log.Printf("Pre-seeded trusted fingerprint: %s", trustedFP)

	registry := requestsigin.NewAgentRegistry()
	if agentKeysPath != "" {
		if loadErr := registry.LoadFromJSON(agentKeysPath); loadErr != nil {
			log.Fatalf("Failed to load agent keys: %v", loadErr)
		}
		log.Printf("Loaded agent keys from %s", agentKeysPath)
	}
	return ts, registry, requestsigin.NewNonceCache(5 * time.Minute)
}

func mustOpenWAL(cfg edgeConfig, metrics *edgeverifier.Metrics) *edgeverifier.DecisionWAL {
	if cfg.walPath == "" && !cfg.syncEnabled {
		return nil
	}
	maxBytes := cfg.walMaxBytes
	if cfg.noDropDecisions && maxBytes <= 0 {
		maxBytes = edgeverifier.NoDropWALMaxBytes(0)
	}
	wal, err := edgeverifier.NewDecisionWAL(edgeverifier.WALConfig{
		Path:     cfg.walPath,
		MaxBytes: maxBytes,
		MaxAge:   cfg.walMaxAge,
		NoDrop:   cfg.noDropDecisions,
		Metrics:  metrics,
	})
	if err != nil {
		log.Fatalf("decision WAL: %v", err)
	}
	log.Printf("Decision WAL enabled path=%q max_bytes=%d max_age=%s no_drop=%v",
		cfg.walPath, wal.MaxBytes(), wal.MaxAge(), cfg.noDropDecisions)
	return wal
}

func mustStartSync(cfg edgeConfig, metrics *edgeverifier.Metrics, wal *edgeverifier.DecisionWAL) (*edgeverifier.Store, *edgeverifier.SyncRunner, context.Context, context.CancelFunc) {
	if cfg.controlPlaneURL == "" || cfg.apiKey == "" {
		log.Fatal("sync enabled requires -control-plane-url / VERILINK_CONTROL_PLANE_URL and VERILINK_API_KEY")
	}
	snapStore := edgeverifier.NewStore()
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.ResponseHeaderTimeout = 30 * time.Second
	client := &edgeverifier.ControlPlaneClient{
		BaseURL: cfg.controlPlaneURL,
		APIKey:  cfg.apiKey,
		HTTPClient: &http.Client{
			Transport: transport,
			Timeout:   0,
		},
	}
	runner := edgeverifier.NewSyncRunner(client, snapStore, cfg.snapshotPath,
		edgeverifier.WithMetrics(metrics),
		edgeverifier.WithDecisionWAL(wal),
	)
	syncCtx, syncCancel := context.WithCancel(context.Background())
	bootCtx, bootCancel := context.WithTimeout(syncCtx, 30*time.Second)
	if err := runner.Bootstrap(bootCtx); err != nil {
		bootCancel()
		log.Fatalf("sync bootstrap: %v", err)
	}
	bootCancel()
	if pol := snapStore.ActivePolicy(); pol != nil && wal != nil {
		wal.SetNoDrop(pol.NoDropDecisions)
	}
	log.Printf("Control-plane sync enabled against %s", cfg.controlPlaneURL)
	return snapStore, runner, syncCtx, syncCancel
}

func startMockBackend() *http.Server {
	mockBackend := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = fmt.Fprintf(w, "Welcome, verified agent! You have reached the backend API.")
	})
	backendServer := &http.Server{
		Addr:              ":8081",
		Handler:           mockBackend,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      10 * time.Second,
		IdleTimeout:       60 * time.Second,
	}
	go func() {
		log.Println("Starting mock backend on :8081")
		if serveErr := backendServer.ListenAndServe(); serveErr != nil && serveErr != http.ErrServerClosed {
			log.Printf("mock backend stopped: %v", serveErr)
		}
	}()
	return backendServer
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func envBool(key string, fallback bool) bool {
	v := os.Getenv(key)
	if v == "" {
		return fallback
	}
	return v == "1" || v == "true" || v == "TRUE" || v == "yes"
}

func envInt64(key string, fallback int64) int64 {
	v := os.Getenv(key)
	if v == "" {
		return fallback
	}
	n, err := strconv.ParseInt(v, 10, 64)
	if err != nil {
		return fallback
	}
	return n
}

func envDuration(key string, fallback time.Duration) time.Duration {
	v := os.Getenv(key)
	if v == "" {
		return fallback
	}
	d, err := time.ParseDuration(v)
	if err != nil {
		return fallback
	}
	return d
}
