package edgeverifier

import (
	"compress/gzip"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// ControlPlaneClient talks to the VeriLink control-plane sync APIs.
type ControlPlaneClient struct {
	BaseURL    string
	APIKey     string
	HTTPClient *http.Client
}

func (c *ControlPlaneClient) http() *http.Client {
	if c.HTTPClient != nil {
		return c.HTTPClient
	}
	return http.DefaultClient
}

func (c *ControlPlaneClient) base() string {
	return strings.TrimRight(c.BaseURL, "/")
}

// FetchSnapshot GETs /v1/sync/snapshot (gzip accepted) and maps it into a Snapshot.
func (c *ControlPlaneClient) FetchSnapshot(ctx context.Context) (*Snapshot, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.base()+"/v1/sync/snapshot", nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+c.APIKey)
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Accept-Encoding", "gzip")

	resp, err := c.http().Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	body := resp.Body
	if resp.Header.Get("Content-Encoding") == "gzip" {
		zr, err := gzip.NewReader(resp.Body)
		if err != nil {
			return nil, err
		}
		defer zr.Close()
		body = zr
	}

	data, err := io.ReadAll(body)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("snapshot: status %d: %s", resp.StatusCode, truncate(string(data), 200))
	}

	return parseSnapshotJSON(data)
}

type cpSnapshotWire struct {
	OK   bool `json:"ok"`
	Data struct {
		HighWaterVersion json.Number `json:"highWaterVersion"`
		Scores           []struct {
			PrincipalID string `json:"principal_id"`
			EntityKind  string `json:"entity_kind"`
			Score       int    `json:"score"`
			Blacklisted bool   `json:"blacklisted"`
			ScoreReason string `json:"score_reason"`
		} `json:"scores"`
		Keys []struct {
			PrincipalID  string  `json:"principal_id"`
			KeyID        string  `json:"key_id"`
			PublicKeyRaw string  `json:"public_key_raw"`
			ValidFrom    string  `json:"valid_from"`
			ValidUntil   *string `json:"valid_until"`
		} `json:"keys"`
		Policy json.RawMessage `json:"policy"`
	} `json:"data"`
}

func parseSnapshotJSON(data []byte) (*Snapshot, error) {
	var wire cpSnapshotWire
	if err := json.Unmarshal(data, &wire); err != nil {
		// allow bare snapshot object (tests / fixtures)
		var bare struct {
			HighWaterVersion json.Number     `json:"highWaterVersion"`
			Scores           json.RawMessage `json:"scores"`
			Keys             json.RawMessage `json:"keys"`
			Policy           json.RawMessage `json:"policy"`
		}
		if err2 := json.Unmarshal(data, &bare); err2 != nil {
			return nil, err
		}
		wrapped, _ := json.Marshal(map[string]any{
			"ok":   true,
			"data": bare,
		})
		return parseSnapshotJSON(wrapped)
	}
	if !wire.OK && wire.Data.HighWaterVersion == "" {
		return nil, fmt.Errorf("snapshot: unexpected response shape")
	}

	hw, err := wire.Data.HighWaterVersion.Int64()
	if err != nil {
		hw = 0
	}
	snap := &Snapshot{
		HighWaterVersion: hw,
		Scores:           make(map[string]ScoreEntry, len(wire.Data.Scores)),
		Keys:             make(map[string]KeyEntry, len(wire.Data.Keys)),
	}
	for _, s := range wire.Data.Scores {
		snap.Scores[s.PrincipalID] = ScoreEntry{
			PrincipalID: s.PrincipalID,
			EntityKind:  s.EntityKind,
			Score:       s.Score,
			Blacklisted: s.Blacklisted,
			ScoreReason: s.ScoreReason,
		}
	}
	for _, k := range wire.Data.Keys {
		raw, err := DecodePublicKeyRaw(k.PublicKeyRaw)
		if err != nil {
			// try std then rawurl already in DecodePublicKeyRaw; also try padded std via RawStd
			raw, err = base64.RawStdEncoding.DecodeString(k.PublicKeyRaw)
			if err != nil || len(raw) != 32 {
				return nil, fmt.Errorf("key %s: %w", k.KeyID, err)
			}
		}
		vf, err := parseTime(k.ValidFrom)
		if err != nil {
			return nil, fmt.Errorf("key %s valid_from: %w", k.KeyID, err)
		}
		var vu *time.Time
		if k.ValidUntil != nil && *k.ValidUntil != "" {
			t, err := parseTime(*k.ValidUntil)
			if err != nil {
				return nil, err
			}
			vu = &t
		}
		snap.Keys[k.KeyID] = KeyEntry{
			PrincipalID:  k.PrincipalID,
			KeyID:        k.KeyID,
			PublicKeyRaw: raw,
			ValidFrom:    vf,
			ValidUntil:   vu,
		}
	}
	if len(wire.Data.Policy) > 0 && string(wire.Data.Policy) != "null" {
		pol, err := parsePolicyPayload(wire.Data.Policy)
		if err != nil {
			return nil, err
		}
		snap.Policy = pol
	}
	return snap, nil
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}
