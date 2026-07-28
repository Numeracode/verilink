package testutil

import (
	"testing"

	"github.com/messagesgoel-blip/verilink/pkg/verifier"
)

func TestStartEdgeVerifier(t *testing.T) {
	ts := verifier.NewMockTrustStore()
	harness := StartEdgeVerifier(t, "http://localhost:9999", ts)
	defer harness.Stop()

	if harness.URL == "" {
		t.Fatal("expected non-empty URL")
	}
}
