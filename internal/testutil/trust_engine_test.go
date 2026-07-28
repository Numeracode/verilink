package testutil

import (
	"testing"
)

func TestStartTrustEngine(t *testing.T) {
	harness := StartTrustEngine(t)
	defer harness.Stop()

	if harness.Client == nil {
		t.Fatal("expected non-nil client")
	}
}
