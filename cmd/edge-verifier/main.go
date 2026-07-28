package main

import (
	"flag"
	"fmt"
	"log"
	"net/http"
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
	)

	flag.StringVar(&externalBaseURL, "external-base-url", "", "Base URL for @target-uri construction (mandatory behind a TLS-terminating proxy)")
	flag.StringVar(&agentKeysPath, "agent-keys-path", "", "Path to agent keys JSON file")
	flag.BoolVar(&requireSignatures, "require-signatures", false, "Require RFC 9421 signatures on all requests")
	flag.Parse()

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
	if err := ts.SetTrustScore(trustedFP, 100); err != nil {
		log.Fatalf("Failed to seed trusted fingerprint: %v", err)
	}
	log.Printf("Pre-seeded trusted fingerprint: %s", trustedFP)

	registry := requestsigin.NewAgentRegistry()
	if agentKeysPath != "" {
		if err := registry.LoadFromJSON(agentKeysPath); err != nil {
			log.Fatalf("Failed to load agent keys: %v", err)
		}
		log.Printf("Loaded agent keys from %s", agentKeysPath)
	}

	nonceCache := requestsigin.NewNonceCache(5 * time.Minute)
	defer nonceCache.Stop()

	mockBackend := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprintf(w, "Welcome, verified agent! You have reached the backend API.")
	})
	go func() {
		log.Println("Starting mock backend on :8081")
		http.ListenAndServe(":8081", mockBackend)
	}()

	proxy, err := edgeverifier.NewEdgeVerifierProxy("http://localhost:8081", ts, registry, nonceCache, requireSignatures, externalBaseURL)
	if err != nil {
		log.Fatal(err)
	}

	log.Println("Verilink Edge Verifier running on :8080")
	log.Fatal(http.ListenAndServe(":8080", proxy))
}
