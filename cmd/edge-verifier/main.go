package main

import (
	"fmt"
	"log"
	"net/http"
	"net/http/httputil"
	"net/url"
	"time"

	"github.com/messagesgoel-blip/verilink/pkg/fingerprint"
	"github.com/messagesgoel-blip/verilink/pkg/verifier"
)

type EdgeVerifierProxy struct {
	proxy      *httputil.ReverseProxy
	trustStore verifier.TrustStore
}

// NewEdgeVerifierProxy creates a new edge verification proxy.
func NewEdgeVerifierProxy(target string, ts verifier.TrustStore) (*EdgeVerifierProxy, error) {
	url, err := url.Parse(target)
	if err != nil {
		return nil, err
	}

	return &EdgeVerifierProxy{
		proxy:      httputil.NewSingleHostReverseProxy(url),
		trustStore: ts,
	}, nil
}

// ServeHTTP handles incoming HTTP requests, performing trust verification before proxying.
func (p *EdgeVerifierProxy) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	start := time.Now()

	// 1. Extract request data for fingerprinting
	data := fingerprint.RequestData{
		JA4:      r.Header.Get("X-JA4-Fingerprint"), // Assume JA4 is added by a front-line LB or Envoy
		Protocol: r.Proto,
		Headers: map[string]string{
			"User-Agent": r.UserAgent(),
		},
	}

	// 2. Generate fingerprint
	fp, err := fingerprint.Generate(data)
	if err != nil {
		log.Printf("ERROR: Failed to generate fingerprint: %v", err)
		http.Error(w, "Internal Server Error", http.StatusInternalServerError)
		return
	}

	// 3. Query Trust Store
	score, err := p.trustStore.GetTrustScore(fp)
	latency := time.Since(start)

	if err != nil || score < verifier.TrustThreshold {
		log.Printf("DENY: fp=%s score=%d latency=%v err=%v", fp, score, latency, err)
		w.Header().Set("X-Verilink-Status", "Denied")
		w.Header().Set("X-Verilink-Fingerprint", fp)
		http.Error(w, "Forbidden: Untrusted Agent", http.StatusForbidden)
		return
	}

	// 4. Authorized: Proxy the request
	log.Printf("ALLOW: fp=%s score=%d latency=%v", fp, score, latency)
	w.Header().Set("X-Verilink-Status", "Allowed")
	w.Header().Set("X-Verilink-Fingerprint", fp)
	p.proxy.ServeHTTP(w, r)
}

func main() {
	// 1. Mock trust store with a pre-trusted agent
	ts := verifier.NewMockTrustStore()

	// Pre-seed a "trusted" agent for demo purposes
	// (FP calculated from JA4: "test-ja4", UA: "TestAgent")
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

	// 2. Target backend (mock)
	mockBackend := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprintf(w, "Welcome, verified agent! You have reached the backend API.")
	})
	go func() {
		log.Println("Starting mock backend on :8081")
		http.ListenAndServe(":8081", mockBackend)
	}()

	// 3. Edge Verifier Proxy
	proxy, err := NewEdgeVerifierProxy("http://localhost:8081", ts)
	if err != nil {
		log.Fatal(err)
	}

	log.Println("Verilink Edge Verifier running on :8080")
	log.Fatal(http.ListenAndServe(":8080", proxy))
}
