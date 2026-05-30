package trust

import (
	"crypto/ed25519"
	"fmt"
	"testing"
	"time"

	"github.com/messagesgoel-blip/verilink/pkg/attestation"
	"github.com/messagesgoel-blip/verilink/pkg/verifier"
)

func TestE2E_TrustPropagation(t *testing.T) {
	// 1. Setup Components
	attestService := attestation.NewService()
	trustEngine := NewEngine()
	edgeCache := verifier.NewMockTrustStore()

	// Use a long interval to prevent background sync from interfering with manual RunSync
	syncService := NewSyncService(attestService, trustEngine, edgeCache, 1*time.Hour)

	// 2. Register a Root of Trust
	rootPubKey, rootPrivKey, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatalf("Failed to generate root key: %v", err)
	}
	rootDID := "did:key:root-enterprise"
	attestService.RegisterIssuer(rootDID, rootPubKey)
	trustEngine.AddRootOfTrust(rootDID)

	// 3. Register a Middleman
	midPubKey, midPrivKey, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatalf("Failed to generate mid key: %v", err)
	}
	midDID := "did:key:middleman"
	attestService.RegisterIssuer(midDID, midPubKey)

	// 4. Create and Submit Attestations
	// Root -> Middleman (100 trust)
	token1, err := attestation.Sign(rootDID, midDID, attestation.VerilinkClaims{TrustLevelDelta: 100}, rootPrivKey)
	if err != nil {
		t.Fatalf("Failed to sign token1: %v", err)
	}
	if err := attestService.SubmitAttestation(token1); err != nil {
		t.Fatalf("Failed to submit token1: %v", err)
	}

	// Middleman -> AgentX (100 trust)
	agentXFP := "VERI-FP-AGENT-X"
	token2, err := attestation.Sign(midDID, agentXFP, attestation.VerilinkClaims{TrustLevelDelta: 100}, midPrivKey)
	if err != nil {
		t.Fatalf("Failed to sign token2: %v", err)
	}
	if err := attestService.SubmitAttestation(token2); err != nil {
		t.Fatalf("Failed to submit token2: %v", err)
	}

	// 5. Manual Sync (Deterministic)
	syncService.RunSync()

	// 6. Polling for expected state (Robustness)
	err = pollForTrustScore(edgeCache, agentXFP, 64, 500*time.Millisecond)
	if err != nil {
		t.Fatal(err)
	}

	// 7. Verify Middleman
	midScore, err := edgeCache.GetTrustScore(midDID)
	if err != nil {
		t.Fatalf("Middleman not found in cache: %v", err)
	}
	if midScore != 80 {
		t.Errorf("Expected Middleman trust score 80, got %d", midScore)
	}
}

// pollForTrustScore polls a trust store until a fingerprint reaches an expected score or timeout expires.
func pollForTrustScore(store verifier.TrustStore, fp string, expected verifier.TrustScore, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		score, err := store.GetTrustScore(fp)
		if err == nil && score == expected {
			return nil
		}
		time.Sleep(10 * time.Millisecond)
	}
	score, _ := store.GetTrustScore(fp)
	return fmt.Errorf("timeout waiting for fingerprint %s to reach score %d (current: %v)", fp, expected, score)
}
