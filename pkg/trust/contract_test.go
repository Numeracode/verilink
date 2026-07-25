package trust

import (
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/messagesgoel-blip/verilink/pkg/attestation"
)

// TestContract_3HopTransitivePropagation guards the unified-namespace invariant:
// an entity that receives trust as a subject must pass it on as an issuer under
// the same ID. If subjects and issuers were split into disjoint namespaces,
// this test would fail (C would score 0 because B-as-subject and B-as-issuer
// would be different nodes).
func TestContract_3HopTransitivePropagation(t *testing.T) {
	engine := NewEngine()
	root := "vrl:p:root"
	a := "vrl:p:a"
	b := "vrl:p:b"
	c := "vrl:p:c"

	now := time.Now()
	claims := []*attestation.AttestationClaims{
		{
			RegisteredClaims: jwt.RegisteredClaims{
				Issuer: root, Subject: a, IssuedAt: jwt.NewNumericDate(now),
			},
			VerilinkClaims: attestation.VerilinkClaims{TrustLevelDelta: 100},
		},
		{
			RegisteredClaims: jwt.RegisteredClaims{
				Issuer: a, Subject: b, IssuedAt: jwt.NewNumericDate(now),
			},
			VerilinkClaims: attestation.VerilinkClaims{TrustLevelDelta: 100},
		},
		{
			RegisteredClaims: jwt.RegisteredClaims{
				Issuer: b, Subject: c, IssuedAt: jwt.NewNumericDate(now),
			},
			VerilinkClaims: attestation.VerilinkClaims{TrustLevelDelta: 100},
		},
	}
	roots := []Root{{ID: root, Weight: 1.0}}
	// All issuers must have Principal rows (propagate defaults missing
	// principals to weight 0 — fail-closed). root, A, and B are all issuers.
	principals := []Principal{
		{ID: root, TrustWeight: 1.0},
		{ID: a, TrustWeight: 1.0},
		{ID: b, TrustWeight: 1.0},
	}

	table := engine.RunVeriRank(claims, principals, roots, now)

	// C must score non-zero — transitive propagation works across 3 hops
	// because A, B, and C share one namespace.
	cScore := scoreForRow(t, table, c)
	if cScore <= 0 {
		t.Fatalf("3-hop contract FAILED: C scored %d (expected >0). "+
			"Unified namespace invariant broken — issuer/subject tables split?", cScore)
	}
	t.Logf("3-hop OK: c=%d", cScore)
}

func scoreForRow(t *testing.T, table ScoreTable, id string) int {
	t.Helper()
	for _, row := range table.Rows {
		if row.PrincipalID == id {
			return row.Score
		}
	}
	t.Fatalf("principal %s not in table", id)
	return 0
}