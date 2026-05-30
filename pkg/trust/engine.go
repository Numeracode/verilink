package trust

import (
	"log"
	"math"
	"sync"
	"time"

	"github.com/messagesgoel-blip/verilink/pkg/attestation"
)

const (
	MaxHops                  = 4
	DistanceDecay            = 0.8
	TimeDecayHalfLifeDays    = 180.0
	MaxClockSkew             = 2 * time.Minute // Tolerance for NTP drift between distributed nodes
	BlacklistIssuerThreshold = 80              // Minimum issuer score to trigger blacklist override
)

type Edge struct {
	Issuer    string
	Subject   string
	Score     int
	Timestamp time.Time
}

type Engine struct {
	mu           sync.RWMutex
	rootsOfTrust map[string]bool
	edges        []Edge
}

// NewEngine creates and returns a new trust engine instance.
func NewEngine() *Engine {
	return &Engine{
		rootsOfTrust: make(map[string]bool),
		edges:        []Edge{},
	}
}

// AddRootOfTrust adds a decentralized identifier (DID) as a root of trust node.
func (e *Engine) AddRootOfTrust(did string) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.rootsOfTrust[did] = true
}

// ResetEdges clears all attestation edges from the trust engine.
func (e *Engine) ResetEdges() {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.edges = e.edges[:0]
}

// AddAttestation adds a single attestation claim to the trust engine.
func (e *Engine) AddAttestation(claims *attestation.AttestationClaims) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.addAttestationLocked(claims)
}

// ReplaceEdgesAndCalculate atomically replaces the entire edge set and returns fresh scores.
func (e *Engine) ReplaceEdgesAndCalculate(claims []*attestation.AttestationClaims) map[string]int {
	e.mu.Lock()
	defer e.mu.Unlock()

	e.edges = e.edges[:0]
	for _, c := range claims {
		e.addAttestationLocked(c)
	}

	return e.calculateScoresLocked()
}

// addAttestationLocked appends a verified attestation claim to the engine's edge list.
// This internal method assumes the caller holds the engine lock.
func (e *Engine) addAttestationLocked(claims *attestation.AttestationClaims) {
	now := time.Now()

	// Validate that claims and claims.IssuedAt are not nil to prevent panic
	if claims == nil {
		log.Printf("WARNING: Skipping attestation: claims is nil — possible malformed token")
		return
	}

	if claims.IssuedAt == nil {
		log.Printf("WARNING: Skipping attestation: claims.IssuedAt is nil (Issuer: %s, Subject: %s)",
			claims.Issuer, claims.Subject)
		return
	}

	// Reject future-dated attestations to prevent time manipulation
	// Allow a MaxClockSkew tolerance for NTP drift between distributed nodes
	if claims.IssuedAt.After(now.Add(MaxClockSkew)) {
		log.Printf("WARNING: Skipping attestation: IssuedAt is beyond clock-skew tolerance (Issuer: %s, Subject: %s, IssuedAt: %v, MaxSkew: %v)",
			claims.Issuer, claims.Subject, claims.IssuedAt, MaxClockSkew)
		return
	}

	// Clamp tolerated future timestamps to now so calculateTimeDecay stays <= 1
	timestamp := claims.IssuedAt.Time
	if timestamp.After(now) {
		timestamp = now
	}

	e.edges = append(e.edges, Edge{
		Issuer:    claims.Issuer,
		Subject:   claims.Subject,
		Score:     claims.VerilinkClaims.TrustLevelDelta,
		Timestamp: timestamp,
	})
}

// CalculateScores runs the VeriRank algorithm to determine trust for all nodes.
func (e *Engine) CalculateScores() map[string]int {
	e.mu.RLock()
	defer e.mu.RUnlock()
	return e.calculateScoresLocked()
}

// calculateScoresLocked computes trust scores for all nodes using the VeriRank algorithm.
// This internal method assumes the caller holds the engine lock.
func (e *Engine) calculateScoresLocked() map[string]int {
	scores := make(map[string]float64)

	// 1. Initialize roots of trust with base score of 100
	for root := range e.rootsOfTrust {
		scores[root] = 100.0
	}

	// 2. Multi-pass propagation (BFS-like) with precomputed blacklist per hop
	for hop := 0; hop < MaxHops; hop++ {
		changed := false

		// Precompute blacklist set from prior-hop scores before accumulating contributions
		// This prevents a blacklisted issuer from propagating trust in the same hop
		blacklisted := make(map[string]bool)
		for _, edge := range e.edges {
			issuerScore, hasIssuerScore := scores[edge.Issuer]
			if hasIssuerScore && edge.Score < 0 && issuerScore >= BlacklistIssuerThreshold {
				blacklisted[edge.Subject] = true
			}
		}

		for _, edge := range e.edges {
			// Skip outbound edges from issuers blacklisted in this hop
			if blacklisted[edge.Issuer] {
				continue
			}

			issuerScore, hasIssuerScore := scores[edge.Issuer]
			if !hasIssuerScore {
				continue
			}

			// Calculate contribution from this edge
			timeDecay := calculateTimeDecay(edge.Timestamp)
			contribution := issuerScore * (float64(edge.Score) / 100.0) * DistanceDecay * timeDecay

			// Update subject score (take the max trust path for now)
			currentScore := scores[edge.Subject]
			if contribution > currentScore {
				scores[edge.Subject] = contribution
				changed = true
			}
		}

		// Apply blacklist overrides
		for subject := range blacklisted {
			if scores[subject] != 0 {
				scores[subject] = 0
				changed = true
			}
		}
		if !changed {
			break
		}
	}

	// 3. Convert to integer 0-100
	finalScores := make(map[string]int)
	for node, score := range scores {
		if score < 0 {
			score = 0
		}
		if score > 100 {
			score = 100
		}
		finalScores[node] = int(math.Round(score))
	}

	return finalScores
}

// calculateTimeDecay computes an exponential decay factor based on time elapsed.
func calculateTimeDecay(t time.Time) float64 {
	daysOld := time.Since(t).Hours() / 24.0
	lambda := math.Log(2) / TimeDecayHalfLifeDays
	return math.Exp(-lambda * daysOld)
}
