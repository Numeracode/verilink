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

// MaxSnapshotBytes caps decompressed snapshot JSON size (bootstrap/recovery).
const MaxSnapshotBytes = 64 << 20 // 64 MiB

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

	if resp.StatusCode != http.StatusOK {
		errBody, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return nil, fmt.Errorf("snapshot: status %d: %s", resp.StatusCode, truncate(string(errBody), 200))
	}

	body := io.Reader(resp.Body)
	if resp.Header.Get("Content-Encoding") == "gzip" {
		zr, err := gzip.NewReader(resp.Body)
		if err != nil {
			return nil, err
		}
		defer zr.Close()
		body = zr
	}

	limited := &io.LimitedReader{R: body, N: MaxSnapshotBytes + 1}
	data, err := io.ReadAll(limited)
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > MaxSnapshotBytes {
		return nil, fmt.Errorf("snapshot: response exceeds %d bytes", MaxSnapshotBytes)
	}

	return parseSnapshotJSON(data)
}

type cpScoreWire struct {
	PrincipalID string `json:"principal_id"`
	EntityKind  string `json:"entity_kind"`
	Score       int    `json:"score"`
	Blacklisted bool   `json:"blacklisted"`
	ScoreReason string `json:"score_reason"`
}

type cpKeyWire struct {
	PrincipalID  string  `json:"principal_id"`
	KeyID        string  `json:"key_id"`
	PublicKeyRaw string  `json:"public_key_raw"`
	ValidFrom    string  `json:"valid_from"`
	ValidUntil   *string `json:"valid_until"`
}

type cpSnapshotWire struct {
	OK   bool `json:"ok"`
	Data struct {
		HighWaterVersion json.Number     `json:"highWaterVersion"`
		Scores           []cpScoreWire   `json:"scores"`
		Keys             []cpKeyWire     `json:"keys"`
		Policy           json.RawMessage `json:"policy"`
	} `json:"data"`
}

func parseSnapshotJSON(data []byte) (*Snapshot, error) {
	wire, err := unmarshalSnapshotWire(data)
	if err != nil {
		return nil, err
	}
	if !wire.OK {
		return nil, fmt.Errorf("snapshot: ok=false")
	}
	if wire.Data.HighWaterVersion == "" {
		return nil, fmt.Errorf("snapshot: missing highWaterVersion")
	}

	hw, err := wire.Data.HighWaterVersion.Int64()
	if err != nil {
		return nil, fmt.Errorf("snapshot: invalid highWaterVersion %q: %w", wire.Data.HighWaterVersion, err)
	}
	if hw < 0 {
		return nil, fmt.Errorf("snapshot: negative highWaterVersion %d", hw)
	}
	snap := &Snapshot{
		HighWaterVersion: hw,
		Scores:           make(map[string]ScoreEntry, len(wire.Data.Scores)),
		Keys:             make(map[string]KeyEntry, len(wire.Data.Keys)),
	}
	if err := loadWireScores(snap, wire.Data.Scores); err != nil {
		return nil, err
	}
	if err := loadWireKeys(snap, wire.Data.Keys); err != nil {
		return nil, err
	}
	if len(wire.Data.Policy) > 0 && string(wire.Data.Policy) != "null" {
		pol, err := parsePolicyPayload(wire.Data.Policy)
		if err != nil {
			return nil, err
		}
		snap.Policy = pol
	}
	if err := validateSnapshot(snap); err != nil {
		return nil, fmt.Errorf("snapshot: %w", err)
	}
	return snap, nil
}

func unmarshalSnapshotWire(data []byte) (cpSnapshotWire, error) {
	var wire cpSnapshotWire
	if err := json.Unmarshal(data, &wire); err != nil {
		return wire, fmt.Errorf("snapshot json: %w", err)
	}
	// Support bare snapshot fixtures (no ok/data wrapper) used in unit tests.
	if wire.OK || wire.Data.HighWaterVersion != "" {
		return wire, nil
	}
	var bare struct {
		HighWaterVersion json.Number     `json:"highWaterVersion"`
		Scores           []cpScoreWire   `json:"scores"`
		Keys             []cpKeyWire     `json:"keys"`
		Policy           json.RawMessage `json:"policy"`
	}
	if err := json.Unmarshal(data, &bare); err != nil {
		return wire, fmt.Errorf("snapshot json: %w", err)
	}
	wire.OK = true
	wire.Data.HighWaterVersion = bare.HighWaterVersion
	wire.Data.Scores = bare.Scores
	wire.Data.Keys = bare.Keys
	wire.Data.Policy = bare.Policy
	return wire, nil
}

func loadWireScores(snap *Snapshot, scores []cpScoreWire) error {
	for _, s := range scores {
		if s.PrincipalID == "" {
			return fmt.Errorf("snapshot: score entry missing principal_id")
		}
		if _, exists := snap.Scores[s.PrincipalID]; exists {
			return fmt.Errorf("snapshot: duplicate principal_id %q", s.PrincipalID)
		}
		snap.Scores[s.PrincipalID] = ScoreEntry(s)
	}
	return nil
}

func loadWireKeys(snap *Snapshot, keys []cpKeyWire) error {
	for _, k := range keys {
		entry, err := wireKeyToEntry(k)
		if err != nil {
			return err
		}
		if _, exists := snap.Keys[entry.KeyID]; exists {
			return fmt.Errorf("snapshot: duplicate key_id %q", entry.KeyID)
		}
		snap.Keys[entry.KeyID] = entry
	}
	return nil
}

func wireKeyToEntry(k cpKeyWire) (KeyEntry, error) {
	if k.KeyID == "" {
		return KeyEntry{}, fmt.Errorf("snapshot: key entry missing key_id")
	}
	raw, err := DecodePublicKeyRaw(k.PublicKeyRaw)
	if err != nil {
		raw, err = base64.RawStdEncoding.DecodeString(k.PublicKeyRaw)
		if err != nil || len(raw) != 32 {
			return KeyEntry{}, fmt.Errorf("key %s: %w", k.KeyID, err)
		}
	}
	vf, err := parseTime(k.ValidFrom)
	if err != nil {
		return KeyEntry{}, fmt.Errorf("key %s valid_from: %w", k.KeyID, err)
	}
	var vu *time.Time
	if k.ValidUntil != nil && *k.ValidUntil != "" {
		t, err := parseTime(*k.ValidUntil)
		if err != nil {
			return KeyEntry{}, err
		}
		vu = &t
	}
	return KeyEntry{
		PrincipalID:  k.PrincipalID,
		KeyID:        k.KeyID,
		PublicKeyRaw: raw,
		ValidFrom:    vf,
		ValidUntil:   vu,
	}, nil
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}
