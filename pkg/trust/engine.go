package trust

import (
	"log"
	"math"
	"sort"
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

// ReplaceEdgesAndCalculate atomically replaces the entire edge set and returns
// fresh scores. Preserved for SyncService.
func (e *Engine) ReplaceEdgesAndCalculate(claims []*attestation.AttestationClaims) map[string]int {
	e.mu.Lock()
	defer e.mu.Unlock()

	e.edges = e.edges[:0]
	for _, c := range claims {
		e.addAttestationLocked(c)
	}

	// Score the sanitized edge snapshot (e.edges) via propagate.
	now := time.Now()
	roots := make([]Root, 0, len(e.rootsOfTrust))
	for did := range e.rootsOfTrust {
		roots = append(roots, Root{ID: did, Weight: 1.0})
	}
	// Legacy path: construct default-weight principals for every issuer.
	issuerSet := make(map[string]bool)
	for _, edge := range e.edges {
		issuerSet[edge.Issuer] = true
	}
	principals := make([]Principal, 0, len(issuerSet))
	for did := range issuerSet {
		principals = append(principals, Principal{ID: did, TrustWeight: 1.0})
	}
	table := e.propagate(e.edges, principals, roots, now)
	out := make(map[string]int, len(table.Rows))
	for _, row := range table.Rows {
		out[row.PrincipalID] = row.Score
	}
	return out
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

// CalculateScores is the legacy entry point. It delegates to propagate with
// default-weight principals (trust_weight = 1.0) and roots (weight = 1.0),
// using time.Now() as the evaluation time. New callers should use RunVeriRank.
func (e *Engine) CalculateScores() map[string]int {
	e.mu.RLock()
	defer e.mu.RUnlock()
	return e.calculateScoresLocked()
}

// calculateScoresLocked delegates to propagate with time.Now() and default
// weights derived from the engine's current rootsOfTrust + edges.
func (e *Engine) calculateScoresLocked() map[string]int {
	now := time.Now()
	roots := make([]Root, 0, len(e.rootsOfTrust))
	for did := range e.rootsOfTrust {
		roots = append(roots, Root{ID: did, Weight: 1.0})
	}
	// Legacy path: construct default-weight principals for every issuer
	// in the edge set so propagate's fail-closed default (weight 0) doesn't
	// zero out legacy scores.
	issuerSet := make(map[string]bool)
	for _, edge := range e.edges {
		issuerSet[edge.Issuer] = true
	}
	principals := make([]Principal, 0, len(issuerSet))
	for did := range issuerSet {
		principals = append(principals, Principal{ID: did, TrustWeight: 1.0})
	}
	table := e.propagate(e.edges, principals, roots, now)
	out := make(map[string]int, len(table.Rows))
	for _, row := range table.Rows {
		out[row.PrincipalID] = row.Score
	}
	return out
}

// RunVeriRank computes trust scores deterministically given the supplied
// attestations, principals (with entity_kind + trust_weight), weighted roots,
// and an explicit evaluation_time. The engine holds no state between calls —
// all data is supplied per-call and computation is call-local.
//
// This is the entry point the gRPC server uses. The legacy CalculateScores()
// and ReplaceEdgesAndCalculate() are preserved for SyncService.
func (e *Engine) RunVeriRank(
	claims []*attestation.AttestationClaims,
	principals []Principal,
	roots []Root,
	evaluationTime time.Time,
) ScoreTable {
	// Build call-local edges from claims, using evaluationTime for future-dated checks.
	var edges []Edge
	for _, c := range claims {
		if c == nil || c.IssuedAt == nil {
			continue
		}
		if c.IssuedAt.After(evaluationTime.Add(MaxClockSkew)) {
			continue // reject future-dated beyond skew
		}
		timestamp := c.IssuedAt.Time
		if timestamp.After(evaluationTime) {
			timestamp = evaluationTime
		}
		edges = append(edges, Edge{
			Issuer:    c.Issuer,
			Subject:   c.Subject,
			Score:     c.VerilinkClaims.TrustLevelDelta,
			Timestamp: timestamp,
		})
	}

	return e.propagate(edges, principals, roots, evaluationTime)
}

// propagate runs the VeriRank BFS propagation algorithm on a pre-built edge
// set. It is the single shared implementation used by RunVeriRank (gRPC path)
// and ReplaceEdgesAndCalculate (legacy SyncService path). Call-local; does not
// mutate e.edges or e.rootsOfTrust.
//
// Missing principal metadata is fail-closed: an issuer not in the principals
// list gets trust_weight = 0 (not 1.0). The legacy wrappers construct
// default-weight principals explicitly so legacy callers see weight 1.0.
func (e *Engine) propagate(
	edges []Edge,
	principals []Principal,
	roots []Root,
	evaluationTime time.Time,
) ScoreTable {
	weightByDID := make(map[string]float64)
	kindByDID := make(map[string]EntityKind)
	for _, p := range principals {
		weightByDID[p.ID] = p.TrustWeight
		kindByDID[p.ID] = p.EntityKind
	}

	rootSet := make(map[string]bool)
	scores := make(map[string]float64)
	for _, r := range roots {
		rootSet[r.ID] = true
		scores[r.ID] = 100.0 * r.Weight
	}

	// Run propagation using previous-hop / next-hop snapshots to avoid
	// edge-order-dependent over-propagation within a single hop.
	blacklistedNodes := make(map[string]bool)
	for hop := 0; hop < MaxHops; hop++ {
		// Precompute blacklist from the CURRENT (previous-hop) scores.
		blacklistedThisHop := make(map[string]bool)
		for _, edge := range edges {
			if edge.Score < 0 {
				if issuerScore, ok := scores[edge.Issuer]; ok && issuerScore >= float64(BlacklistIssuerThreshold) {
					blacklistedThisHop[edge.Subject] = true
				}
			}
		}

		// Compute next-hop scores from the current snapshot.
		nextScores := make(map[string]float64)
		for k, v := range scores {
			nextScores[k] = v
		}
		changed := false
		for _, edge := range edges {
			if blacklistedThisHop[edge.Issuer] {
				continue
			}
			issuerScore, hasIssuerScore := scores[edge.Issuer]
			if !hasIssuerScore {
				continue
			}
			timeDecay := calculateTimeDecayAt(edge.Timestamp, evaluationTime)
			// Fail-closed: issuers not in the principals list get weight 0,
			// not 1.0. Legacy wrappers construct default-weight principals.
			weight := 0.0
			if w, ok := weightByDID[edge.Issuer]; ok {
				weight = w
			}
			contribution := issuerScore * (float64(edge.Score) / 100.0) * DistanceDecay * timeDecay * weight
			if contribution > nextScores[edge.Subject] {
				nextScores[edge.Subject] = contribution
				changed = true
			}
		}

		// Apply blacklist overrides UNCONDITIONALLY — a known principal
		// receiving a qualifying negative incident gets blacklisted even
		// without a prior positive path (the subject may have been
		// initialized to 0 by a root with weight 0, or may not yet have
		// a score row; the override still marks it).
		for subject := range blacklistedThisHop {
			nextScores[subject] = 0
			blacklistedNodes[subject] = true
			changed = true
		}

		scores = nextScores
		if !changed {
			break
		}
	}

	// Build sorted ScoreTable.
	rows := make([]ScoreRow, 0, len(scores))
	for node, score := range scores {
		clamped := score
		if clamped < 0 {
			clamped = 0
		}
		if clamped > 100 {
			clamped = 100
		}
		rounded := int(math.Round(clamped))

		reason := ScoreReasonPropagated
		blacklisted := false
		if blacklistedNodes[node] {
			blacklisted = true
			reason = ScoreReasonBlacklisted
		}

		rows = append(rows, ScoreRow{
			PrincipalID: node,
			EntityKind:  kindByDID[node],
			Score:       rounded,
			Blacklisted: blacklisted,
			ScoreReason: reason,
		})
	}

	// Sort by PrincipalID for deterministic serialization.
	sort.Slice(rows, func(i, j int) bool {
		return rows[i].PrincipalID < rows[j].PrincipalID
	})

	return ScoreTable{
		Rows:           rows,
		ComputedAtUnix: evaluationTime.Unix(),
	}
}

// calculateTimeDecayAt is the evaluation_time-aware version of calculateTimeDecay.
func calculateTimeDecayAt(t time.Time, evaluationTime time.Time) float64 {
	daysOld := evaluationTime.Sub(t).Hours() / 24.0
	if daysOld < 0 {
		daysOld = 0
	}
	lambda := math.Log(2) / TimeDecayHalfLifeDays
	return math.Exp(-lambda * daysOld)
}

// calculateTimeDecay computes an exponential decay factor based on time elapsed.
func calculateTimeDecay(t time.Time) float64 {
	daysOld := time.Since(t).Hours() / 24.0
	lambda := math.Log(2) / TimeDecayHalfLifeDays
	return math.Exp(-lambda * daysOld)
}
