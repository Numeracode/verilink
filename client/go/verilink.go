// Package verilink provides a lightweight Go client for the VeriLink
// attestation service. Import it in Codero or any other Go consumer:
//
//	import "github.com/messagesgoel-blip/verilink/client/go"
//
// Typical usage:
//
//	c, err := verilink.NewClient(verilink.Config{
//	    AttestationURL: "http://verilink-attest:8082",
//	    IssuerDID:      "did:key:codero-system",
//	    PrivateKey:     privKey, // ed25519.PrivateKey
//	})
//	err = c.SubmitAttestation(ctx, "did:key:aider-agent", map[string]any{"action":"commit"}, 10)
//	score, err := c.GetTrustScore(ctx, fingerprint)
package verilink

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/messagesgoel-blip/verilink/pkg/attestation"
)

// Config holds the client configuration.
type Config struct {
	// AttestationURL is the base URL of the VeriLink attestation service,
	// e.g. "http://verilink-attest:8082".
	AttestationURL string

	// IssuerDID identifies the signing party, e.g. "did:key:codero-system".
	IssuerDID string

	// PrivateKey is the Ed25519 private key used to sign attestations.
	PrivateKey ed25519.PrivateKey

	// HTTPClient allows injecting a custom *http.Client (optional).
	// Defaults to a client with a 10s timeout.
	HTTPClient *http.Client
}

// Client submits attestations and queries trust scores.
type Client struct {
	cfg Config
	hc  *http.Client
}

// NewClient validates cfg and returns a ready Client.
func NewClient(cfg Config) (*Client, error) {
	cfg.AttestationURL = strings.TrimRight(cfg.AttestationURL, "/")
	if cfg.AttestationURL == "" {
		return nil, fmt.Errorf("verilink: AttestationURL is required")
	}
	if _, err := url.Parse(cfg.AttestationURL); err != nil {
		return nil, fmt.Errorf("verilink: invalid AttestationURL: %w", err)
	}
	if cfg.IssuerDID == "" {
		return nil, fmt.Errorf("verilink: IssuerDID is required")
	}
	if len(cfg.PrivateKey) != ed25519.PrivateKeySize {
		return nil, fmt.Errorf("verilink: PrivateKey must be %d bytes", ed25519.PrivateKeySize)
	}
	hc := cfg.HTTPClient
	if hc == nil {
		hc = &http.Client{Timeout: 10 * time.Second}
	}
	return &Client{cfg: cfg, hc: hc}, nil
}

// SubmitAttestation signs and submits a behavioural attestation for subject.
//
//   - subject:        DID or opaque identifier of the agent being attested.
//   - facts:          Arbitrary key/value behavioural facts.
//   - trustLevelDelta: Score delta to apply during the next trust sync (-100 to +100).
func (c *Client) SubmitAttestation(ctx context.Context, subject string, facts map[string]any, trustLevelDelta int) error {
	if trustLevelDelta < -100 || trustLevelDelta > 100 {
		return fmt.Errorf("verilink: trustLevelDelta must be in [-100, 100], got %d", trustLevelDelta)
	}
	vli := attestation.VerilinkClaims{
		Type:            "behavioral",
		Facts:           facts,
		TrustLevelDelta: trustLevelDelta,
	}
	token, err := attestation.Sign(c.cfg.IssuerDID, subject, vli, c.cfg.PrivateKey)
	if err != nil {
		return fmt.Errorf("verilink: sign: %w", err)
	}

	body, err := json.Marshal(map[string]string{"token": token})
	if err != nil {
		return fmt.Errorf("verilink: marshal: %w", err)
	}

	req, err := http.NewRequestWithContext(
		ctx, http.MethodPost,
		c.cfg.AttestationURL+"/v1/attestations/submit",
		bytes.NewReader(body),
	)
	if err != nil {
		return fmt.Errorf("verilink: build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.hc.Do(req)
	if err != nil {
		return fmt.Errorf("verilink: submit: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode >= 400 {
		msg, readErr := io.ReadAll(io.LimitReader(resp.Body, 512))
		if readErr != nil {
			return fmt.Errorf("verilink: submit returned %d (body unreadable: %w)", resp.StatusCode, readErr)
		}
		return fmt.Errorf("verilink: submit returned %d: %s", resp.StatusCode, string(bytes.TrimSpace(msg)))
	}
	return nil
}

// TrustResponse is the JSON body returned by GET /v1/trust.
type TrustResponse struct {
	Score int `json:"score"`
}

// GetTrustScore returns the cached trust score (0–100) for fingerprint.
// Returns 0 if the fingerprint is unknown.
func (c *Client) GetTrustScore(ctx context.Context, fingerprint string) (int, error) {
	u := c.cfg.AttestationURL + "/v1/trust?fingerprint=" + url.QueryEscape(fingerprint)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return 0, fmt.Errorf("verilink: build request: %w", err)
	}
	req.Header.Set("Accept", "application/json")

	resp, err := c.hc.Do(req)
	if err != nil {
		return 0, fmt.Errorf("verilink: get trust score: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode == http.StatusNotFound {
		return 0, nil
	}
	if resp.StatusCode >= 400 {
		msg, readErr := io.ReadAll(io.LimitReader(resp.Body, 512))
		if readErr != nil {
			return 0, fmt.Errorf("verilink: trust query returned %d (body unreadable: %w)", resp.StatusCode, readErr)
		}
		return 0, fmt.Errorf("verilink: trust query returned %d: %s", resp.StatusCode, string(bytes.TrimSpace(msg)))
	}

	var tr TrustResponse
	if err := json.NewDecoder(resp.Body).Decode(&tr); err != nil {
		return 0, fmt.Errorf("verilink: decode response: %w", err)
	}
	return tr.Score, nil
}

// IsTrusted returns true if the fingerprint's score meets threshold.
func (c *Client) IsTrusted(ctx context.Context, fingerprint string, threshold int) (bool, error) {
	score, err := c.GetTrustScore(ctx, fingerprint)
	if err != nil {
		return false, err
	}
	return score >= threshold, nil
}
