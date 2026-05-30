package trust

import (
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/messagesgoel-blip/verilink/pkg/attestation"
)

func TestEngine_CalculateScores(t *testing.T) {
	engine := NewEngine()

	// 1. Setup Root of Trust (did:key:R)
	rootDID := "did:key:R"
	engine.AddRootOfTrust(rootDID)

	// 2. Add Attestation: R -> A (score 100)
	engine.AddAttestation(&attestation.AttestationClaims{
		RegisteredClaims: jwt.RegisteredClaims{
			Issuer:   rootDID,
			Subject:  "did:key:A",
			IssuedAt: jwt.NewNumericDate(time.Now()),
		},
		VerilinkClaims: attestation.VerilinkClaims{TrustLevelDelta: 100},
	})

	// 3. Add Attestation: A -> AgentX (score 100)
	engine.AddAttestation(&attestation.AttestationClaims{
		RegisteredClaims: jwt.RegisteredClaims{
			Issuer:   "did:key:A",
			Subject:  "agent-X",
			IssuedAt: jwt.NewNumericDate(time.Now()),
		},
		VerilinkClaims: attestation.VerilinkClaims{TrustLevelDelta: 100},
	})

	scores := engine.CalculateScores()

	// 4. Verify propagation with distance decay (0.8 per hop)
	// R (100) -> A (100 * 1.0 * 0.8 = 80) -> AgentX (80 * 1.0 * 0.8 = 64)
	if scores["did:key:A"] != 80 {
		t.Errorf("Expected score for A: 80, got %d", scores["did:key:A"])
	}
	if scores["agent-X"] != 64 {
		t.Errorf("Expected score for AgentX: 64, got %d", scores["agent-X"])
	}
}

func TestEngine_NegativeOverride(t *testing.T) {
	engine := NewEngine()
	rootDID := "did:key:R"
	engine.AddRootOfTrust(rootDID)

	// R trusts A
	engine.AddAttestation(&attestation.AttestationClaims{
		RegisteredClaims: jwt.RegisteredClaims{
			Issuer:   rootDID,
			Subject:  "did:key:A",
			IssuedAt: jwt.NewNumericDate(time.Now()),
		},
		VerilinkClaims: attestation.VerilinkClaims{TrustLevelDelta: 100},
	})

	// A trusts AgentX
	engine.AddAttestation(&attestation.AttestationClaims{
		RegisteredClaims: jwt.RegisteredClaims{
			Issuer:   "did:key:A",
			Subject:  "agent-X",
			IssuedAt: jwt.NewNumericDate(time.Now()),
		},
		VerilinkClaims: attestation.VerilinkClaims{TrustLevelDelta: 100},
	})

	// R (Root) reports AgentX is BAD (-100)
	engine.AddAttestation(&attestation.AttestationClaims{
		RegisteredClaims: jwt.RegisteredClaims{
			Issuer:   rootDID,
			Subject:  "agent-X",
			IssuedAt: jwt.NewNumericDate(time.Now()),
		},
		VerilinkClaims: attestation.VerilinkClaims{TrustLevelDelta: -100},
	})

	scores := engine.CalculateScores()

	if scores["agent-X"] != 0 {
		t.Errorf("Expected AgentX to be blacklisted (score 0), got %d", scores["agent-X"])
	}
}

func TestEngine_TimeDecay(t *testing.T) {
	engine := NewEngine()
	rootDID := "did:key:R"
	engine.AddRootOfTrust(rootDID)

	// Old attestation (180 days ago = 1 half-life = 0.5 decay)
	engine.AddAttestation(&attestation.AttestationClaims{
		RegisteredClaims: jwt.RegisteredClaims{
			Issuer:   rootDID,
			Subject:  "agent-old",
			IssuedAt: jwt.NewNumericDate(time.Now().Add(-180 * 24 * time.Hour)),
		},
		VerilinkClaims: attestation.VerilinkClaims{TrustLevelDelta: 100},
	})

	scores := engine.CalculateScores()

	// R (100) -> agent-old (100 * 1.0 * 0.8 [distance] * 0.5 [time] = 40)
	if scores["agent-old"] != 40 {
		t.Errorf("Expected score for agent-old: 40, got %d", scores["agent-old"])
	}
}
