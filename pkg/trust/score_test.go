package trust

import "testing"

func TestScoreReasonConstants(t *testing.T) {
	if ScoreReasonPropagated != "propagated" {
		t.Errorf("expected propagated, got %s", ScoreReasonPropagated)
	}
	if ScoreReasonBlacklisted != "blacklisted" {
		t.Errorf("expected blacklisted, got %s", ScoreReasonBlacklisted)
	}
}

func TestRootWeight(t *testing.T) {
	r := Root{ID: "vrl:p:abc", Weight: 0.5}
	if r.Weight != 0.5 {
		t.Errorf("expected 0.5, got %f", r.Weight)
	}
}