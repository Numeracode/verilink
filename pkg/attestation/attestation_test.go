package attestation

import (
	"crypto/ed25519"
	"testing"
)

func TestSignAndVerify_Success(t *testing.T) {
	// 1. Generate test keys
	pubKey, privKey, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatalf("failed to generate keys: %v", err)
	}

	// 2. Setup mock attestation facts
	vli := VerilinkClaims{
		Type: "transaction_summary",
		Facts: map[string]interface{}{
			"successful_invoices": float64(142),
			"dispute_count":       float64(0),
		},
		TrustLevelDelta: 10,
	}

	issuer := "did:key:z6MkhaX..."
	subject := "VERI-FP-SHA256-..."

	// 3. Sign
	token, err := Sign(issuer, subject, vli, privKey)
	if err != nil {
		t.Fatalf("Sign failed: %v", err)
	}

	// 4. Verify
	claims, err := Verify(token, pubKey)
	if err != nil {
		t.Fatalf("Verify failed: %v", err)
	}

	// 5. Assert claims match
	if claims.Issuer != issuer {
		t.Errorf("Expected issuer %s, got %s", issuer, claims.Issuer)
	}
	if claims.Subject != subject {
		t.Errorf("Expected subject %s, got %s", subject, claims.Subject)
	}
	if claims.VerilinkClaims.Type != vli.Type {
		t.Errorf("Expected type %s, got %s", vli.Type, claims.VerilinkClaims.Type)
	}

	// Check deep facts (JSON marshaling converts numbers to float64 by default)
	if claims.VerilinkClaims.Facts["successful_invoices"] != 142.0 {
		t.Errorf("Expected successful_invoices: 142, got %v", claims.VerilinkClaims.Facts["successful_invoices"])
	}
}

func TestVerify_InvalidSignature(t *testing.T) {
	_, privKey1, _ := ed25519.GenerateKey(nil)
	pubKey2, _, _ := ed25519.GenerateKey(nil) // Different key pair

	vli := VerilinkClaims{Type: "test"}
	token, _ := Sign("iss", "sub", vli, privKey1)

	// Attempt to verify with the WRONG public key
	_, err := Verify(token, pubKey2)
	if err == nil {
		t.Errorf("Expected error when verifying with wrong public key, got nil")
	}
}
