package testutil

import (
	"net/http"
	"strconv"
	"testing"

	trustpb "github.com/messagesgoel-blip/verilink/pkg/trustpb"
)

// AssertSignedVerified checks X-Verilink-Auth-Status is signed-verified.
func AssertSignedVerified(t *testing.T, resp *http.Response) {
	t.Helper()
	if got := resp.Header.Get("X-Verilink-Auth-Status"); got != "signed-verified" {
		t.Errorf("expected X-Verilink-Auth-Status: signed-verified, got %s", got)
	}
}

// AssertUnsignedPassthrough checks X-Verilink-Auth-Status is unsigned-passthrough.
func AssertUnsignedPassthrough(t *testing.T, resp *http.Response) {
	t.Helper()
	if got := resp.Header.Get("X-Verilink-Auth-Status"); got != "unsigned-passthrough" {
		t.Errorf("expected X-Verilink-Auth-Status: unsigned-passthrough, got %s", got)
	}
}

// AssertUnsignedRejected checks unsigned-rejected status and HTTP 401.
func AssertUnsignedRejected(t *testing.T, resp *http.Response) {
	t.Helper()
	if got := resp.Header.Get("X-Verilink-Auth-Status"); got != "unsigned-rejected" {
		t.Errorf("expected X-Verilink-Auth-Status: unsigned-rejected, got %s", got)
	}
	if resp.StatusCode != http.StatusUnauthorized {
		t.Errorf("expected 401, got %d", resp.StatusCode)
	}
}

// AssertInvalidSignature checks invalid-signature status and HTTP 401.
func AssertInvalidSignature(t *testing.T, resp *http.Response) {
	t.Helper()
	if got := resp.Header.Get("X-Verilink-Auth-Status"); got != "invalid-signature" {
		t.Errorf("expected X-Verilink-Auth-Status: invalid-signature, got %s", got)
	}
	if resp.StatusCode != http.StatusUnauthorized {
		t.Errorf("expected 401, got %d", resp.StatusCode)
	}
}

// AssertTrustScoreHeader checks X-Verilink-Trust-Score equals expected.
func AssertTrustScoreHeader(t *testing.T, resp *http.Response, expected int) {
	t.Helper()
	score := resp.Header.Get("X-Verilink-Trust-Score")
	if score == "" {
		t.Error("expected X-Verilink-Trust-Score header to be set")
		return
	}
	got, err := strconv.Atoi(score)
	if err != nil {
		t.Errorf("failed to parse X-Verilink-Trust-Score %q: %v", score, err)
		return
	}
	if got != expected {
		t.Errorf("expected trust score %d, got %d", expected, got)
	}
}

// AssertScoreTable asserts a principal's score in a ScoreTable.
func AssertScoreTable(t *testing.T, table *trustpb.ScoreTable, principalID string, expectedScore int32) {
	t.Helper()
	for _, row := range table.Rows {
		if row.PrincipalId == principalID {
			if row.Score != expectedScore {
				t.Errorf("expected score %d for %s, got %d", expectedScore, principalID, row.Score)
			}
			return
		}
	}
	t.Errorf("principal %s not found in score table", principalID)
}
