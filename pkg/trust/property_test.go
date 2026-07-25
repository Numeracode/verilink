package trust

import (
	"math/rand"
	"testing"
	"testing/quick"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/messagesgoel-blip/verilink/pkg/attestation"
)

func claim(issuer, subject string, delta int, at time.Time) *attestation.AttestationClaims {
	return &attestation.AttestationClaims{
		RegisteredClaims: jwt.RegisteredClaims{
			Issuer: issuer, Subject: subject, IssuedAt: jwt.NewNumericDate(at),
		},
		VerilinkClaims: attestation.VerilinkClaims{TrustLevelDelta: delta},
	}
}

// defaultWeightPrincipals builds Principal rows with trust_weight=1.0 for
// every ID. Needed because propagate defaults missing principals to weight 0
// (fail-closed) — tests must supply principal rows for every issuer.
func defaultWeightPrincipals(ids ...string) []Principal {
	out := make([]Principal, 0, len(ids))
	for _, id := range ids {
		out = append(out, Principal{ID: id, TrustWeight: 1.0})
	}
	return out
}

// TestProperty_UnrootedClusterZeroScore: an issuer cluster with no path from
// any root produces NO score rows (unrooted nodes are never initialized).
func TestProperty_UnrootedClusterZeroScore(t *testing.T) {
	engine := NewEngine()
	now := time.Now()
	claims := []*attestation.AttestationClaims{
		claim("vrl:p:a", "vrl:p:b", 100, now),
	}
	table := engine.RunVeriRank(claims, nil, nil, now)
	if len(table.Rows) != 0 {
		t.Errorf("unrooted cluster produced %d rows (expected 0)", len(table.Rows))
		for _, row := range table.Rows {
			t.Errorf("  unexpected row: %s score=%d", row.PrincipalID, row.Score)
		}
	}
}

// TestProperty_MonotonicityUnderPositiveAttestations: adding a positive
// attestation never decreases any principal's score.
func TestProperty_MonotonicityUnderPositiveAttestations(t *testing.T) {
	f := func(seed int64) bool {
		r := rand.New(rand.NewSource(seed))
		now := time.Now()
		root := "vrl:p:root"
		roots := []Root{{ID: root, Weight: 1.0}}

		delta1 := 1 + r.Intn(99) // [1, 99] — positive
		claims1 := []*attestation.AttestationClaims{
			claim(root, "vrl:p:a", delta1, now),
		}
		principals := defaultWeightPrincipals(root)
		table1 := NewEngine().RunVeriRank(claims1, principals, roots, now)
		scoreA1 := scoreForRow(t, table1, "vrl:p:a")

		delta2 := 1 + r.Intn(99) // additional positive
		claims2 := []*attestation.AttestationClaims{
			claim(root, "vrl:p:a", delta1, now),
			claim(root, "vrl:p:a", delta2, now),
		}
		table2 := NewEngine().RunVeriRank(claims2, principals, roots, now)
		scoreA2 := scoreForRow(t, table2, "vrl:p:a")

		return scoreA2 >= scoreA1
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 50}); err != nil {
		t.Error(err)
	}
}

// TestProperty_DecayMonotonic: older attestations produce lower scores than
// fresh ones, all else equal. Uses a bounded age (uint16 % 366 days).
func TestProperty_DecayMonotonic(t *testing.T) {
	f := func(ageSeed uint16) bool {
		ageDays := int(ageSeed) % 366 // 0..365
		if ageDays == 0 {
			return true // skip zero-age (trivially equal)
		}
		engine := NewEngine()
		root := "vrl:p:root"
		roots := []Root{{ID: root, Weight: 1.0}}
		evalNow := time.Now()

		fresh := claim(root, "vrl:p:fresh", 100, evalNow)
		old := claim(root, "vrl:p:old", 100, evalNow.Add(-time.Duration(ageDays)*24*time.Hour))

		principals := defaultWeightPrincipals(root)
		tableFresh := engine.RunVeriRank([]*attestation.AttestationClaims{fresh}, principals, roots, evalNow)
		tableOld := engine.RunVeriRank([]*attestation.AttestationClaims{old}, principals, roots, evalNow)

		sf := scoreForRow(t, tableFresh, "vrl:p:fresh")
		so := scoreForRow(t, tableOld, "vrl:p:old")
		// Use <= for generated integer scores (rounding may collapse
		// small differences). A separate known-age test asserts strict <.
		return so <= sf
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 50}); err != nil {
		t.Error(err)
	}
}

// TestProperty_DecayStrictDecrease: a known 365-day-old attestation scores
// strictly less than a fresh one (not just <=). 365 days = 2 half-lives ≈
// 25% of the fresh contribution, so the scores differ after rounding.
func TestProperty_DecayStrictDecrease(t *testing.T) {
	engine := NewEngine()
	root := "vrl:p:root"
	roots := []Root{{ID: root, Weight: 1.0}}
	evalNow := time.Now()

	fresh := claim(root, "vrl:p:fresh", 100, evalNow)
	old := claim(root, "vrl:p:old", 100, evalNow.Add(-365*24*time.Hour))

	principals := defaultWeightPrincipals(root)
	tableFresh := engine.RunVeriRank([]*attestation.AttestationClaims{fresh}, principals, roots, evalNow)
	tableOld := engine.RunVeriRank([]*attestation.AttestationClaims{old}, principals, roots, evalNow)

	sf := scoreForRow(t, tableFresh, "vrl:p:fresh")
	so := scoreForRow(t, tableOld, "vrl:p:old")
	if so >= sf {
		t.Errorf("strict decrease failed: old %d >= fresh %d", so, sf)
	}
}

// TestProperty_PermutationInvariance: the order of attestations in the input
// does not change the output.
func TestProperty_PermutationInvariance(t *testing.T) {
	f := func(seed int64) bool {
		r := rand.New(rand.NewSource(seed))
		now := time.Now()
		root := "vrl:p:root"
		roots := []Root{{ID: root, Weight: 1.0}}

		claims := []*attestation.AttestationClaims{
			claim(root, "vrl:p:a", 100, now),
			claim("vrl:p:a", "vrl:p:b", 100, now),
			claim("vrl:p:b", "vrl:p:c", 100, now),
		}
		principals := defaultWeightPrincipals(root, "vrl:p:a", "vrl:p:b")
		// Shuffle
		r.Shuffle(len(claims), func(i, j int) {
			claims[i], claims[j] = claims[j], claims[i]
		})

		table := NewEngine().RunVeriRank(claims, principals, roots, now)
		// Run again with a different shuffle
		r.Shuffle(len(claims), func(i, j int) {
			claims[i], claims[j] = claims[j], claims[i]
		})
		table2 := NewEngine().RunVeriRank(claims, principals, roots, now)

		if len(table.Rows) != len(table2.Rows) {
			return false
		}
		for i := range table.Rows {
			if table.Rows[i] != table2.Rows[i] {
				return false
			}
		}
		return true
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 50}); err != nil {
		t.Error(err)
	}
}

// TestProperty_TrustWeightReducesContribution: an issuer with trust_weight < 1.0
// contributes less than the same issuer with trust_weight = 1.0.
func TestProperty_TrustWeightReducesContribution(t *testing.T) {
	engine := NewEngine()
	root := "vrl:p:root"
	a := "vrl:p:a"
	target := "vrl:p:target"
	now := time.Now()
	roots := []Root{{ID: root, Weight: 1.0}}

	claims := []*attestation.AttestationClaims{
		claim(root, a, 100, now),
		claim(a, target, 100, now),
	}

	// Root must have weight 1.0; A's weight varies.
	fullWeight := defaultWeightPrincipals(root, a)
	halfWeight := []Principal{{ID: root, TrustWeight: 1.0}, {ID: a, TrustWeight: 0.5}}

	tableFull := engine.RunVeriRank(claims, fullWeight, roots, now)
	tableHalf := engine.RunVeriRank(claims, halfWeight, roots, now)

	scoreFull := scoreForRow(t, tableFull, target)
	scoreHalf := scoreForRow(t, tableHalf, target)
	if scoreHalf >= scoreFull {
		t.Errorf("trust_weight 0.5 (%d) should be < trust_weight 1.0 (%d)", scoreHalf, scoreFull)
	}
}

// TestProperty_EvaluationTimeDeterminism: same inputs + same evaluation_time
// produce identical output (including row order, since rows are sorted).
func TestProperty_EvaluationTimeDeterminism(t *testing.T) {
	engine := NewEngine()
	root := "vrl:p:root"
	roots := []Root{{ID: root, Weight: 1.0}}
	evalTime := time.Date(2026, 7, 25, 12, 0, 0, 0, time.UTC)
	claims := []*attestation.AttestationClaims{
		claim(root, "vrl:p:a", 100, evalTime),
		claim("vrl:p:a", "vrl:p:b", 100, evalTime),
	}
	principals := defaultWeightPrincipals(root, "vrl:p:a")

	t1 := engine.RunVeriRank(claims, principals, roots, evalTime)
	t2 := engine.RunVeriRank(claims, principals, roots, evalTime)
	if len(t1.Rows) != len(t2.Rows) {
		t.Fatalf("row count differs: %d vs %d", len(t1.Rows), len(t2.Rows))
	}
	for i := range t1.Rows {
		if t1.Rows[i] != t2.Rows[i] {
			t.Errorf("row %d differs: %+v vs %+v", i, t1.Rows[i], t2.Rows[i])
		}
	}
}

// TestProperty_HopBounds: a chain of exactly MaxHops (4) edges propagates to
// the 4th node; the 5th node (5 hops) must NOT be reached.
func TestProperty_HopBounds(t *testing.T) {
	engine := NewEngine()
	root := "vrl:p:root"
	now := time.Now()
	roots := []Root{{ID: root, Weight: 1.0}}

	// root -> a0 -> a1 -> a2 -> a3 -> a4
	// a0 = 1 hop, a1 = 2, a2 = 3, a3 = 4 (MaxHops), a4 = 5 (must NOT propagate).
	claims := []*attestation.AttestationClaims{
		claim(root, "vrl:p:a0", 100, now),
		claim("vrl:p:a0", "vrl:p:a1", 100, now),
		claim("vrl:p:a1", "vrl:p:a2", 100, now),
		claim("vrl:p:a2", "vrl:p:a3", 100, now),
		claim("vrl:p:a3", "vrl:p:a4", 100, now),
	}
	principals := defaultWeightPrincipals(root, "vrl:p:a0", "vrl:p:a1", "vrl:p:a2", "vrl:p:a3")
	table := engine.RunVeriRank(claims, principals, roots, now)

	// a3 (4 hops) MUST be present with a non-zero score.
	a3Score := 0
	a3Found := false
	for _, row := range table.Rows {
		if row.PrincipalID == "vrl:p:a3" {
			a3Score = row.Score
			a3Found = true
		}
	}
	if !a3Found || a3Score <= 0 {
		t.Errorf("a3 (4 hops) should have non-zero score, got found=%v score=%d", a3Found, a3Score)
	}

	// a4 (5 hops) must NOT be present or must be zero.
	for _, row := range table.Rows {
		if row.PrincipalID == "vrl:p:a4" && row.Score > 0 {
			t.Errorf("a4 (5 hops) scored %d — MaxHops=4 boundary violated", row.Score)
		}
	}
}

// TestProperty_WeightedRootScaling: a root with weight 0.5 initializes at 50,
// not 100.
func TestProperty_WeightedRootScaling(t *testing.T) {
	engine := NewEngine()
	root := "vrl:p:root"
	now := time.Now()
	roots := []Root{{ID: root, Weight: 0.5}}

	claims := []*attestation.AttestationClaims{
		claim(root, "vrl:p:a", 100, now),
	}
	principals := defaultWeightPrincipals(root)
	table := engine.RunVeriRank(claims, principals, roots, now)

	rootScore := scoreForRow(t, table, root)
	if rootScore != 50 {
		t.Errorf("weighted root (weight=0.5) should initialize at 50, got %d", rootScore)
	}
}

// TestProperty_ExplicitBlacklist: a negative_incident from a high-trust issuer
// sets blacklisted=true and score_reason=blacklisted. The override applies
// unconditionally — a known principal receiving a qualifying negative incident
// gets blacklisted even without a prior positive path.
func TestProperty_ExplicitBlacklist(t *testing.T) {
	engine := NewEngine()
	root := "vrl:p:root"
	target := "vrl:p:target"
	now := time.Now()
	roots := []Root{{ID: root, Weight: 1.0}}

	claims := []*attestation.AttestationClaims{
		claim(root, target, 100, now),       // target gets a positive score
		claim(root, target, -100, now),      // root (score≥80) blacklists target
	}
	principals := defaultWeightPrincipals(root)
	table := engine.RunVeriRank(claims, principals, roots, now)

	for _, row := range table.Rows {
		if row.PrincipalID == target {
			if !row.Blacklisted {
				t.Error("expected blacklisted=true for target")
			}
			if row.ScoreReason != ScoreReasonBlacklisted {
				t.Errorf("expected score_reason=blacklisted, got %s", row.ScoreReason)
			}
			if row.Score != 0 {
				t.Errorf("expected score=0 for blacklisted target, got %d", row.Score)
			}
			return
		}
	}
	t.Fatal("target not found in score table")
}

// TestProperty_BlacklistWithoutPriorPositive: a qualifying negative incident
// blacklists a known principal even if it had no prior positive path. The
// subject is initialized (root with weight 1.0 initializes the root; the
// negative incident from the root blacklists the subject unconditionally).
func TestProperty_BlacklistWithoutPriorPositive(t *testing.T) {
	engine := NewEngine()
	root := "vrl:p:root"
	target := "vrl:p:target"
	now := time.Now()
	roots := []Root{{ID: root, Weight: 1.0}}

	// Only a negative incident — no prior positive attestation to target.
	claims := []*attestation.AttestationClaims{
		claim(root, target, -100, now),
	}
	principals := defaultWeightPrincipals(root)
	table := engine.RunVeriRank(claims, principals, roots, now)

	// The target MUST appear in the score table with blacklisted=true
	// (unconditional override — the subject is initialized by the override
	// even without a prior positive path).
	targetFound := false
	for _, row := range table.Rows {
		if row.PrincipalID == target {
			targetFound = true
			if !row.Blacklisted {
				t.Error("expected blacklisted=true for target (unconditional override)")
			}
			if row.ScoreReason != ScoreReasonBlacklisted {
				t.Errorf("expected score_reason=blacklisted, got %s", row.ScoreReason)
			}
		}
	}
	if !targetFound {
		t.Fatal("target not found in score table — unconditional blacklist failed to create a row")
	}
}
