package main

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/messagesgoel-blip/verilink/pkg/fingerprint"
	"github.com/messagesgoel-blip/verilink/pkg/verifier"
)

func TestEdgeVerifierProxy_AllowDeny(t *testing.T) {
	// 1. Setup Mock Backend
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("Backend Success"))
	}))
	defer backend.Close()

	// 2. Setup Trust Store with one trusted agent
	ts := verifier.NewMockTrustStore()
	trustedData := fingerprint.RequestData{
		JA4:      "trusted-ja4",
		Protocol: "HTTP/1.1",
		Headers:  map[string]string{"User-Agent": "TrustedAgent"},
	}
	trustedFP, err := fingerprint.Generate(trustedData)
	if err != nil {
		t.Fatalf("Failed to generate trusted fingerprint: %v", err)
	}
	if err := ts.SetTrustScore(trustedFP, 100); err != nil {
		t.Fatalf("Failed to seed trusted fingerprint: %v", err)
	}

	// 3. Setup Proxy
	proxy, _ := NewEdgeVerifierProxy(backend.URL, ts)

	// Test Case 1: Trusted Agent (JA4: trusted-ja4, UA: TrustedAgent)
	req1 := httptest.NewRequest("GET", "http://localhost:8080", nil)
	req1.Header.Set("X-JA4-Fingerprint", "trusted-ja4")
	req1.Header.Set("User-Agent", "TrustedAgent")
	rr1 := httptest.NewRecorder()

	proxy.ServeHTTP(rr1, req1)

	if rr1.Code != http.StatusOK {
		t.Errorf("Expected 200 OK for trusted agent, got %d", rr1.Code)
	}
	if rr1.Header().Get("X-Verilink-Status") != "Allowed" {
		t.Errorf("Expected X-Verilink-Status: Allowed, got %s", rr1.Header().Get("X-Verilink-Status"))
	}

	// Test Case 2: Untrusted Agent (Wrong UA)
	req2 := httptest.NewRequest("GET", "http://localhost:8080", nil)
	req2.Header.Set("X-JA4-Fingerprint", "trusted-ja4")
	req2.Header.Set("User-Agent", "EvilAgent") // Changed UA = Different Fingerprint
	rr2 := httptest.NewRecorder()

	proxy.ServeHTTP(rr2, req2)

	if rr2.Code != http.StatusForbidden {
		t.Errorf("Expected 403 Forbidden for untrusted agent, got %d", rr2.Code)
	}
	if rr2.Header().Get("X-Verilink-Status") != "Denied" {
		t.Errorf("Expected X-Verilink-Status: Denied, got %s", rr2.Header().Get("X-Verilink-Status"))
	}
}
