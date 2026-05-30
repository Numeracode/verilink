package main

import (
	"bytes"
	"crypto/ed25519"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/messagesgoel-blip/verilink/pkg/attestation"
)

func TestServer_SubmitHandler(t *testing.T) {
	service := attestation.NewService()
	pubKey, privKey, _ := ed25519.GenerateKey(nil)
	issuerDID := "did:key:test-issuer"
	service.RegisterIssuer(issuerDID, pubKey)

	server := &Server{service: service}

	// 1. Create a valid token
	vli := attestation.VerilinkClaims{Type: "test"}
	token, _ := attestation.Sign(issuerDID, "agent-001", vli, privKey)

	payload := map[string]string{"token": token}
	body, _ := json.Marshal(payload)

	// 2. Submit via handler
	req := httptest.NewRequest("POST", "/v1/attestations/submit", bytes.NewBuffer(body))
	rr := httptest.NewRecorder()
	server.SubmitHandler(rr, req)

	if rr.Code != http.StatusAccepted {
		t.Errorf("Expected 202 Accepted, got %d", rr.Code)
	}

	// 3. Verify it's in the list
	if len(service.GetAttestations()) != 1 {
		t.Errorf("Expected 1 attestation, got %d", len(service.GetAttestations()))
	}
}
