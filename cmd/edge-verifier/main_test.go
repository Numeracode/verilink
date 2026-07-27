package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/messagesgoel-blip/verilink/pkg/requestsigin"
)

func TestEdgeVerifierProxy_SignedRequestAllowed(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("Backend Success"))
	}))
	defer backend.Close()

	registry := requestsigin.NewAgentRegistry()
	nonceCache := requestsigin.NewNonceCache(5 * time.Minute)
	defer nonceCache.Stop()

	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("Failed to generate keypair: %v", err)
	}

	keyID := "vrl:agent:did:web:example.com:agent1:signing-key"
	if err := registry.Register(&requestsigin.AgentEntry{
		DID: "did:web:example.com:agent1", KeyLabel: "signing-key",
		PublicKeyB64: base64.RawURLEncoding.EncodeToString(pub),
	}); err != nil {
		t.Fatalf("Failed to register agent: %v", err)
	}

	proxy, _ := NewEdgeVerifierProxy(backend.URL, nil, registry, nonceCache, false, "")

	now := time.Now().Unix()
	sigInput, signature, err := requestsigin.Sign("GET", "http://localhost:8080/", now, now+300, []byte{}, keyID, priv)
	if err != nil {
		t.Fatalf("Failed to sign request: %v", err)
	}

	req := httptest.NewRequest("GET", "http://localhost:8080/", nil)
	req.Header.Set("Signature-Input", sigInput)
	req.Header.Set("Signature", signature)
	rr := httptest.NewRecorder()

	proxy.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Errorf("Expected 200, got %d", rr.Code)
	}
}

func TestEdgeVerifierProxy_UnsignedPassesWhenPermissive(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("OK"))
	}))
	defer backend.Close()

	registry := requestsigin.NewAgentRegistry()
	nonceCache := requestsigin.NewNonceCache(5 * time.Minute)
	defer nonceCache.Stop()

	proxy, _ := NewEdgeVerifierProxy(backend.URL, nil, registry, nonceCache, false, "")

	req := httptest.NewRequest("GET", "http://localhost:8080/", nil)
	rr := httptest.NewRecorder()

	proxy.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Errorf("Expected 200 for unsigned permissive, got %d", rr.Code)
	}
	if rr.Header().Get("X-Verilink-Auth-Status") != "unsigned-passthrough" {
		t.Errorf("Expected unsigned-passthrough, got %s", rr.Header().Get("X-Verilink-Auth-Status"))
	}
}

func TestEdgeVerifierProxy_UnsignedRejectsWhenStrict(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("OK"))
	}))
	defer backend.Close()

	registry := requestsigin.NewAgentRegistry()
	nonceCache := requestsigin.NewNonceCache(5 * time.Minute)
	defer nonceCache.Stop()

	proxy, _ := NewEdgeVerifierProxy(backend.URL, nil, registry, nonceCache, true, "")

	req := httptest.NewRequest("GET", "http://localhost:8080/", nil)
	rr := httptest.NewRecorder()

	proxy.ServeHTTP(rr, req)

	if rr.Code != http.StatusUnauthorized {
		t.Errorf("Expected 401 for unsigned strict, got %d", rr.Code)
	}
	if rr.Header().Get("X-Verilink-Auth-Status") != "unsigned-rejected" {
		t.Errorf("Expected unsigned-rejected, got %s", rr.Header().Get("X-Verilink-Auth-Status"))
	}
}

func TestEdgeVerifierProxy_InvalidSignature(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("OK"))
	}))
	defer backend.Close()

	registry := requestsigin.NewAgentRegistry()
	nonceCache := requestsigin.NewNonceCache(5 * time.Minute)
	defer nonceCache.Stop()

	pub, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("Failed to generate keypair: %v", err)
	}

	keyID := "vrl:agent:did:web:example.com:agent1:signing-key"
	if err := registry.Register(&requestsigin.AgentEntry{
		DID: "did:web:example.com:agent1", KeyLabel: "signing-key",
		PublicKeyB64: base64.RawURLEncoding.EncodeToString(pub),
	}); err != nil {
		t.Fatalf("Failed to register agent: %v", err)
	}

	proxy, _ := NewEdgeVerifierProxy(backend.URL, nil, registry, nonceCache, false, "")

	now := time.Now().Unix()
	_, otherPriv, _ := ed25519.GenerateKey(rand.Reader)
	sigInput, signature, err := requestsigin.Sign("GET", "http://localhost:8080/", now, now+300, []byte{}, keyID, otherPriv)
	if err != nil {
		t.Fatalf("Failed to sign request: %v", err)
	}

	req := httptest.NewRequest("GET", "http://localhost:8080/", nil)
	req.Header.Set("Signature-Input", sigInput)
	req.Header.Set("Signature", signature)
	rr := httptest.NewRecorder()

	proxy.ServeHTTP(rr, req)

	if rr.Code != http.StatusUnauthorized {
		t.Errorf("Expected 401 for invalid sig, got %d", rr.Code)
	}
	if rr.Header().Get("X-Verilink-Auth-Status") != "invalid-signature" {
		t.Errorf("Expected invalid-signature, got %s", rr.Header().Get("X-Verilink-Auth-Status"))
	}
}
