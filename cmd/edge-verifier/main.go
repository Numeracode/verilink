package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/messagesgoel-blip/verilink/internal/edgeverifier"
	"github.com/messagesgoel-blip/verilink/pkg/fingerprint"
	"github.com/messagesgoel-blip/verilink/pkg/requestsigin"
	"github.com/messagesgoel-blip/verilink/pkg/verifier"
)

func main() {
	var (
		externalBaseURL   string
		agentKeysPath     string
		requireSignatures bool
		controlPlaneURL   string
		snapshotPath      string
		syncEnabled       bool
	)

	flag.StringVar(&externalBaseURL, "external-base-url", "", "Base URL for @target-uri construction (mandatory behind a TLS-terminating proxy)")
	flag.StringVar(&agentKeysPath, "agent-keys-path", "", "Path to agent keys JSON file (demo/bootstrap; synced keys win when sync enabled)")
	flag.BoolVar(&requireSignatures, "require-signatures", false, "Require RFC 9421 signatures on all requests")
	flag.StringVar(&controlPlaneURL, "control-plane-url", envOr("VERILINK_CONTROL_PLANE_URL", ""), "Control plane base URL")
	flag.StringVar(&snapshotPath, "snapshot-path", envOr("VERILINK_SNAPSHOT_PATH", ""), "On-disk snapshot path")
	flag.BoolVar(&syncEnabled, "sync", false, "Enable control-plane sync (also true when URL+key set unless VERILINK_SYNC_ENABLED=false)")
	flag.Parse()

	// API key is env-only — never accept via argv (shell history / process listings).
	apiKey := os.Getenv("VERILINK_API_KEY")

	if v := os.Getenv("VERILINK_SYNC_ENABLED"); v == "false" || v == "0" {
		syncEnabled = false
	} else if controlPlaneURL != "" && apiKey != "" {
		syncEnabled = true
	}

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

	nonceCache := requestsigin.NewNonceCache(5 * time.Minute)
	defer nonceCache.Stop()

	var (
		snapStore  *edgeverifier.Store
		syncCancel context.CancelFunc
		syncCtx    context.Context
		syncRunner *edgeverifier.SyncRunner
	)
	if syncEnabled {
		if controlPlaneURL == "" || apiKey == "" {
			log.Fatal("sync enabled requires -control-plane-url / VERILINK_CONTROL_PLANE_URL and VERILINK_API_KEY")
		}
		snapStore = edgeverifier.NewStore()
		transport := http.DefaultTransport.(*http.Transport).Clone()
		transport.ResponseHeaderTimeout = 30 * time.Second
		client := &edgeverifier.ControlPlaneClient{
			BaseURL: controlPlaneURL,
			APIKey:  apiKey,
			HTTPClient: &http.Client{
				Transport: transport,
				Timeout:   0, // SSE is long-lived; snapshot fetch uses per-request context deadlines
			},
		}
		syncRunner = edgeverifier.NewSyncRunner(client, snapStore, snapshotPath)
		syncCtx, syncCancel = context.WithCancel(context.Background())
		bootCtx, bootCancel := context.WithTimeout(syncCtx, 30*time.Second)
		if err := syncRunner.Bootstrap(bootCtx); err != nil {
			bootCancel()
			log.Fatalf("sync bootstrap: %v", err)
		}
		bootCancel()
		log.Printf("Control-plane sync enabled against %s", controlPlaneURL)
	}

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

	proxy, err := edgeverifier.NewEdgeVerifierProxyWithSnapshot(
		"http://localhost:8081", ts, registry, nonceCache, requireSignatures, externalBaseURL, snapStore,
	)
	if err != nil {
		log.Fatal(err)
	}

	if syncRunner != nil {
		syncRunner.OnReachable = proxy.SetSyncReachable
		go func() {
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

	go func() {
		sigCh := make(chan os.Signal, 1)
		signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
		<-sigCh
		log.Printf("shutting down…")
		if syncCancel != nil {
			syncCancel()
		}
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = server.Shutdown(shutdownCtx)
		_ = backendServer.Shutdown(shutdownCtx)
	}()

	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatal(err)
	}
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
