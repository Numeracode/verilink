package main

import (
	"bytes"
	crypto_ed25519 "crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/messagesgoel-blip/verilink/internal/edgeverifier"
	"github.com/messagesgoel-blip/verilink/pkg/requestsigin"
)

func TestFullSignedFlow(t *testing.T) {
	var receivedMethod string
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		receivedMethod = r.Method
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("OK"))
	}))
	defer backend.Close()

	registry := requestsigin.NewAgentRegistry()
	nonceCache := requestsigin.NewNonceCache(5 * time.Minute)
	defer nonceCache.Stop()

	pub, priv, err := crypto_ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("keypair: %v", err)
	}

	keyID := "vrl:agent:did:web:e2e.test:agent1|key"
	if err := registry.Register(&requestsigin.AgentEntry{
		DID: "did:web:e2e.test:agent1", KeyLabel: "key",
		PublicKeyB64: base64.RawURLEncoding.EncodeToString(pub),
	}); err != nil {
		t.Fatalf("register: %v", err)
	}

	proxy, _ := edgeverifier.NewEdgeVerifierProxy(backend.URL, nil, registry, nonceCache, false, "")

	now := time.Now().Unix()
	targetURI := backend.URL + "/api/resource"

	t.Run("signed request reaches backend", func(t *testing.T) {
		body := []byte(`{"data":1}`)
		sigIn, sig, err := requestsigin.Sign("POST", targetURI, now, now+300, body, keyID, priv)
		if err != nil {
			t.Fatalf("sign: %v", err)
		}
		req, _ := http.NewRequest("POST", targetURI, bytes.NewReader(body))
		req.Header.Set("Signature-Input", sigIn)
		req.Header.Set("Signature", sig)
		req.Header.Set("Content-Type", "application/json")
		rr := httptest.NewRecorder()
		proxy.ServeHTTP(rr, req)
		if rr.Code != http.StatusOK {
			t.Fatalf("expected 200, got %d: %s", rr.Code, rr.Body.String())
		}
		if receivedMethod != "POST" {
			t.Errorf("backend saw %s, want POST", receivedMethod)
		}
	})

	t.Run("unsigned passthrough", func(t *testing.T) {
		req, _ := http.NewRequest("GET", backend.URL+"/health", nil)
		rr := httptest.NewRecorder()
		proxy.ServeHTTP(rr, req)
		if rr.Code != http.StatusOK {
			t.Fatalf("expected 200, got %d", rr.Code)
		}
		if rr.Header().Get("X-Verilink-Auth-Status") != "unsigned-passthrough" {
			t.Errorf("want unsigned-passthrough, got %s", rr.Header().Get("X-Verilink-Auth-Status"))
		}
	})

	t.Run("tampered body rejected", func(t *testing.T) {
		body := []byte(`{"data":1}`)
		sigIn, sig, _ := requestsigin.Sign("PUT", targetURI, now, now+300, body, keyID, priv)
		// send with different body
		tampered := []byte(`{"data":2}`)
		req, _ := http.NewRequest("PUT", targetURI, bytes.NewReader(tampered))
		req.Header.Set("Signature-Input", sigIn)
		req.Header.Set("Signature", sig)
		req.Header.Set("Content-Type", "application/json")
		rr := httptest.NewRecorder()
		proxy.ServeHTTP(rr, req)
		if rr.Code != http.StatusUnauthorized {
			t.Fatalf("expected 401 for tampered body, got %d: %s", rr.Code, rr.Body.String())
		}
	})

	t.Run("strict mode rejects unsigned", func(t *testing.T) {
		strictProxy, _ := edgeverifier.NewEdgeVerifierProxy(backend.URL, nil, registry, nonceCache, true, "")
		req, _ := http.NewRequest("GET", backend.URL+"/admin", nil)
		rr := httptest.NewRecorder()
		strictProxy.ServeHTTP(rr, req)
		if rr.Code != http.StatusUnauthorized {
			t.Fatalf("expected 401 strict, got %d", rr.Code)
		}
		if rr.Header().Get("X-Verilink-Auth-Status") != "unsigned-rejected" {
			t.Errorf("want unsigned-rejected, got %s", rr.Header().Get("X-Verilink-Auth-Status"))
		}
	})
}
