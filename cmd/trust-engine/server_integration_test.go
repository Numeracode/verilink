//go:build integration

package main

import (
	"context"
	"testing"

	"github.com/messagesgoel-blip/verilink/internal/testutil"
	trustpb "github.com/messagesgoel-blip/verilink/pkg/trustpb"
)

func TestTrustEngine_GetFingerprint(t *testing.T) {
	harness := testutil.StartTrustEngine(t)
	defer harness.Stop()

	resp, err := harness.Client.GetFingerprint(context.Background(), &trustpb.FingerprintRequest{
		Ja4:      "t13d311100_0013_150a",
		Protocol: "h2",
		Headers:  map[string]string{"User-Agent": "TestAgent"},
	})
	if err != nil {
		t.Fatal(err)
	}

	if resp.Sha256 == "" {
		t.Error("expected non-empty fingerprint")
	}
}

func TestTrustEngine_VerifyAttestation(t *testing.T) {
	harness := testutil.StartTrustEngine(t)
	defer harness.Stop()

	resp, err := harness.Client.VerifyAttestation(context.Background(), &trustpb.VerifyRequest{
		JwsToken: "invalid.token.here",
	})
	if err != nil {
		t.Fatal(err)
	}

	if resp.Valid {
		t.Error("expected invalid attestation to fail verification")
	}
}
