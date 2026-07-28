package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/messagesgoel-blip/verilink/internal/edgeverifier"
	"github.com/messagesgoel-blip/verilink/pkg/fingerprint"
	"github.com/messagesgoel-blip/verilink/pkg/requestsigin"
	"github.com/messagesgoel-blip/verilink/pkg/verifier"
)

// BenchmarkEdgeVerifierDecision measures local decision overhead (fingerprint
// generation + cache lookup + allow/deny) for a single pre-seeded trusted
// request. The backend is an in-memory httptest server (no-op handler), so
// upstream work is ~0; however, httptest includes loopback transport latency,
// so the reported ns/op is an UPPER BOUND on local decision overhead, not a
// pure measurement. The real VR-002 p99/throughput gate is the nightly k6 run
// on a pinned runner per the spec.
func BenchmarkEdgeVerifierDecision(b *testing.B) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(200)
	}))
	defer backend.Close()

	// Seed the trust store with the COMPUTED fingerprint for the request
	// we'll send (matching the demo in main.go).
	trustedData := fingerprint.RequestData{
		JA4:      "test-ja4",
		Protocol: "HTTP/1.1",
		Headers:  map[string]string{"User-Agent": "TestAgent"},
	}
	trustedFP, err := fingerprint.Generate(trustedData)
	if err != nil {
		b.Fatal(err)
	}

	ts := verifier.NewMockTrustStore()
	if err := ts.SetTrustScore(trustedFP, 100); err != nil {
		b.Fatal(err)
	}

	registry := requestsigin.NewAgentRegistry()
	nonceCache := requestsigin.NewNonceCache(5 * time.Minute)
	defer nonceCache.Stop()

	proxy, err := edgeverifier.NewEdgeVerifierProxy(backend.URL, ts, registry, nonceCache, false, "")
	if err != nil {
		b.Fatal(err)
	}

	req := httptest.NewRequest("GET", "/v1/resource", nil)
	req.Header.Set("X-JA4-Fingerprint", "test-ja4")
	req.Header.Set("User-Agent", "TestAgent")

	b.ResetTimer()
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		w := httptest.NewRecorder()
		proxy.ServeHTTP(w, req)
		if w.Code != 200 {
			b.Fatalf("expected 200 (allowed), got %d — fingerprint may not match the seeded trust store entry", w.Code)
		}
	}
}
