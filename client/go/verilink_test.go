package verilink

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/messagesgoel-blip/verilink/pkg/requestsigin"
)

func testClient(t *testing.T) *Client {
	t.Helper()
	_, priv, err := ed25519.GenerateKey(strings.NewReader("test-seed-for-verilink-client-32!"))
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	c, err := NewClient(Config{
		AttestationURL: "http://localhost:9999",
		IssuerDID:      "did:key:test-agent",
		PrivateKey:     priv,
	})
	if err != nil {
		t.Fatalf("new client: %v", err)
	}
	return c
}

func TestSignRequest(t *testing.T) {
	c := testClient(t)
	req := httptest.NewRequest(http.MethodPost, "http://localhost:9999/v1/attestations/submit", strings.NewReader(`{"token":"x"}`))

	if err := c.SignRequest(req, "default"); err != nil {
		t.Fatalf("SignRequest: %v", err)
	}

	if req.Header.Get("Signature-Input") == "" {
		t.Error("Signature-Input header not set")
	}
	if req.Header.Get("Signature") == "" {
		t.Error("Signature header not set")
	}
	if !strings.Contains(req.Header.Get("Signature-Input"), "vrl:agent:did:key:test-agent|default") {
		t.Errorf("Signature-Input missing keyid: %s", req.Header.Get("Signature-Input"))
	}
}

func TestSignRequest_NilBody(t *testing.T) {
	c := testClient(t)
	req := httptest.NewRequest(http.MethodGet, "http://localhost:9999/v1/trust", nil)

	if err := c.SignRequest(req, "default"); err != nil {
		t.Fatalf("SignRequest with nil body: %v", err)
	}
	if req.Header.Get("Signature-Input") == "" {
		t.Error("Signature-Input header not set")
	}
}

func TestMakeRequest_Signed(t *testing.T) {
	c := testClient(t)
	body := []byte(`{"subject":"did:key:alice"}`)

	req, err := c.MakeRequest(context.Background(), http.MethodPost, "/v1/attestations/submit", body, "prod")
	if err != nil {
		t.Fatalf("MakeRequest: %v", err)
	}

	if req.Header.Get("Signature-Input") == "" {
		t.Error("Signature-Input header not set for signed request")
	}
	if req.Header.Get("Signature") == "" {
		t.Error("Signature header not set for signed request")
	}
	if req.Header.Get("Content-Type") != "application/json" {
		t.Errorf("Content-Type = %q, want application/json", req.Header.Get("Content-Type"))
	}
}

func TestMakeRequest_Unsigned(t *testing.T) {
	c := testClient(t)

	req, err := c.MakeRequest(context.Background(), http.MethodGet, "/v1/trust", nil, "")
	if err != nil {
		t.Fatalf("MakeRequest: %v", err)
	}

	if req.Header.Get("Signature-Input") != "" {
		t.Error("Signature-Input should not be set for unsigned request")
	}
	if req.Header.Get("Signature") != "" {
		t.Error("Signature should not be set for unsigned request")
	}
	if req.Header.Get("Content-Type") != "" {
		t.Errorf("Content-Type should not be set for bodyless request, got %q", req.Header.Get("Content-Type"))
	}
}

func TestSignRequest_RoundTrip(t *testing.T) {
	_, priv, err := ed25519.GenerateKey(strings.NewReader("roundtrip-seed-32-bytes-test-ok!"))
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	pub, ok := priv.Public().(ed25519.PublicKey)
	if !ok {
		t.Fatalf("failed to assert public key type")
	}

	c, err := NewClient(Config{
		AttestationURL: "http://localhost:9999",
		IssuerDID:      "did:key:roundtrip",
		PrivateKey:     priv,
	})
	if err != nil {
		t.Fatalf("new client: %v", err)
	}

	body := []byte(`{"facts":{"action":"commit"}}`)
	req := httptest.NewRequest(http.MethodPost, "http://localhost:9999/v1/attestations/submit", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")

	if err := c.SignRequest(req, "default"); err != nil {
		t.Fatalf("SignRequest: %v", err)
	}

	sigInputHeader := req.Header.Get("Signature-Input")
	sigHeader := req.Header.Get("Signature")

	targetURI := "http://localhost:9999/v1/attestations/submit"
	getBody := func() []byte { return body }
	lookupKey := func(keyid string) (ed25519.PublicKey, error) {
		if keyid == "vrl:agent:did:key:roundtrip|default" {
			return pub, nil
		}
		return nil, fmt.Errorf("unknown keyid: %s", keyid)
	}

	if err := requestsigin.VerifySignatureInput(sigInputHeader, sigHeader, http.MethodPost, targetURI, getBody, lookupKey); err != nil {
		t.Fatalf("VerifySignatureInput: %v", err)
	}
}
