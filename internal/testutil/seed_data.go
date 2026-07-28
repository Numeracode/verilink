package testutil

import (
	"crypto/ed25519"
	"crypto/rand"
	"testing"

	trustpb "github.com/messagesgoel-blip/verilink/pkg/trustpb"
)

// TestIssuer is a generated Ed25519 keypair for attestation / signing tests.
type TestIssuer struct {
	DID        string
	PublicKey  ed25519.PublicKey
	PrivateKey ed25519.PrivateKey
}

// GenerateTestIssuer creates a fresh Ed25519 issuer keypair.
func GenerateTestIssuer(t *testing.T) *TestIssuer {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("failed to generate key: %v", err)
	}
	return &TestIssuer{
		DID:        "did:key:test-issuer",
		PublicKey:  pub,
		PrivateKey: priv,
	}
}

// SeedTestData validates harness inputs. Trust-engine state is streamed
// per-test via RunVeriRank; there is no global seed RPC.
func SeedTestData(t *testing.T, client trustpb.TrustEngineClient, issuer *TestIssuer) {
	t.Helper()
	if client == nil {
		t.Fatal("nil trust engine client")
	}
	if issuer == nil {
		t.Fatal("nil issuer")
	}
}
