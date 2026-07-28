//go:build integration

package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/messagesgoel-blip/verilink/internal/edgeverifier"
	"github.com/messagesgoel-blip/verilink/internal/testutil"
	"github.com/messagesgoel-blip/verilink/pkg/fingerprint"
	"github.com/messagesgoel-blip/verilink/pkg/requestsigin"
	"github.com/messagesgoel-blip/verilink/pkg/verifier"
)

func TestEdgeVerifier_SignedVerified(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("backend response"))
	}))
	defer backend.Close()

	ts := verifier.NewMockTrustStore()
	fpData := fingerprint.RequestData{
		JA4:      "test-ja4",
		Protocol: "HTTP/1.1",
		Headers:  map[string]string{"User-Agent": "TestAgent"},
	}
	fp, err := fingerprint.Generate(fpData)
	if err != nil {
		t.Fatal(err)
	}
	if err := ts.SetTrustScore(fp, 75); err != nil {
		t.Fatal(err)
	}

	harness := testutil.StartEdgeVerifier(t, backend.URL, ts)
	defer harness.Stop()

	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	did := "did:web:test.example:agent1"
	keyLabel := "key-1"
	keyID := "vrl:agent:" + did + "|" + keyLabel
	if err := harness.Registry.Register(&requestsigin.AgentEntry{
		DID:          did,
		KeyLabel:     keyLabel,
		PublicKeyB64: base64.RawURLEncoding.EncodeToString(pub),
	}); err != nil {
		t.Fatal(err)
	}

	targetURI := harness.URL + "/test"
	now := time.Now().Unix()
	sigInput, signature, err := requestsigin.Sign("GET", targetURI, now, now+300, nil, keyID, priv)
	if err != nil {
		t.Fatal(err)
	}

	req, err := http.NewRequest("GET", targetURI, nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Signature-Input", sigInput)
	req.Header.Set("Signature", signature)
	req.Header.Set("X-JA4-Fingerprint", "test-ja4")
	req.Header.Set("User-Agent", "TestAgent")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d", resp.StatusCode)
	}
	testutil.AssertSignedVerified(t, resp)
	testutil.AssertTrustScoreHeader(t, resp, 75)
}

func TestEdgeVerifier_UnsignedPassthrough(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer backend.Close()

	ts := verifier.NewMockTrustStore()
	harness := testutil.StartEdgeVerifier(t, backend.URL, ts)
	defer harness.Stop()

	req, err := http.NewRequest("GET", harness.URL+"/test", nil)
	if err != nil {
		t.Fatal(err)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d", resp.StatusCode)
	}
	testutil.AssertUnsignedPassthrough(t, resp)
}

func TestEdgeVerifier_UnsignedRejected(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer backend.Close()

	ts := verifier.NewMockTrustStore()
	registry := requestsigin.NewAgentRegistry()
	nonceCache := requestsigin.NewNonceCache(5 * time.Minute)
	defer nonceCache.Stop()

	proxy, err := edgeverifier.NewEdgeVerifierProxy(backend.URL, ts, registry, nonceCache, true, "")
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(proxy)
	defer server.Close()

	req, err := http.NewRequest("GET", server.URL+"/test", nil)
	if err != nil {
		t.Fatal(err)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()

	testutil.AssertUnsignedRejected(t, resp)
}
