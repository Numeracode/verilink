package attestation

import (
	"crypto/ed25519"
	"testing"
)

func TestService_SubmitAttestation(t *testing.T) {
	// 1. Setup Service and Trusted Issuer
	service := NewService()
	pubKey, privKey, _ := ed25519.GenerateKey(nil)
	issuerDID := "did:key:trusted-issuer"
	service.RegisterIssuer(issuerDID, pubKey)

	// 2. Setup Malicious Issuer
	_, maliciousPrivKey, _ := ed25519.GenerateKey(nil)

	// 3. Test Case 1: Trusted Attestation
	vli1 := VerilinkClaims{Type: "test_success"}
	token1, _ := Sign(issuerDID, "agent-001", vli1, privKey)

	err := service.SubmitAttestation(token1)
	if err != nil {
		t.Errorf("Expected success for trusted attestation, got error: %v", err)
	}

	if len(service.GetAttestations()) != 1 {
		t.Errorf("Expected 1 attestation in store, got %d", len(service.GetAttestations()))
	}

	// 4. Test Case 2: Untrusted Issuer
	vli2 := VerilinkClaims{Type: "test_malicious"}
	token2, _ := Sign("did:key:untrusted-issuer", "agent-001", vli2, maliciousPrivKey)

	err = service.SubmitAttestation(token2)
	if err == nil {
		t.Errorf("Expected error for untrusted issuer, got nil")
	}

	// 5. Test Case 3: Trusted DID but WRONG Key (Spoof attempt)
	token3, _ := Sign(issuerDID, "agent-001", vli2, maliciousPrivKey)

	err = service.SubmitAttestation(token3)
	if err == nil {
		t.Errorf("Expected error for signature mismatch, got nil")
	}
}
