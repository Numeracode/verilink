package edgeverifier

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

const diskSchemaVersion = 1

type diskEnvelope struct {
	SchemaVersion    int         `json:"schema_version"`
	HighWaterVersion int64       `json:"highWaterVersion"`
	Scores           []diskScore `json:"scores"`
	Keys             []diskKey   `json:"keys"`
	Policy           *Policy     `json:"policy,omitempty"`
}

type diskScore struct {
	PrincipalID string `json:"principal_id"`
	EntityKind  string `json:"entity_kind"`
	Score       int    `json:"score"`
	Blacklisted bool   `json:"blacklisted"`
	ScoreReason string `json:"score_reason"`
}

type diskKey struct {
	PrincipalID  string  `json:"principal_id"`
	KeyID        string  `json:"key_id"`
	PublicKeyRaw string  `json:"public_key_raw"` // std base64
	ValidFrom    string  `json:"valid_from"`
	ValidUntil   *string `json:"valid_until,omitempty"`
}

// SaveSnapshot atomically persists snap to path (tmp → fsync → rename → dir fsync).
func SaveSnapshot(path string, snap *Snapshot) error {
	if path == "" {
		return fmt.Errorf("empty snapshot path")
	}
	if snap == nil {
		return fmt.Errorf("nil snapshot")
	}
	env := diskEnvelope{
		SchemaVersion:    diskSchemaVersion,
		HighWaterVersion: snap.HighWaterVersion,
		Policy:           snap.Policy,
	}
	for _, s := range snap.Scores {
		env.Scores = append(env.Scores, diskScore(s))
	}
	for _, k := range snap.Keys {
		dk := diskKey{
			PrincipalID:  k.PrincipalID,
			KeyID:        k.KeyID,
			PublicKeyRaw: base64.StdEncoding.EncodeToString(k.PublicKeyRaw),
			ValidFrom:    k.ValidFrom.UTC().Format(time.RFC3339Nano),
		}
		if k.ValidUntil != nil {
			s := k.ValidUntil.UTC().Format(time.RFC3339Nano)
			dk.ValidUntil = &s
		}
		env.Keys = append(env.Keys, dk)
	}

	data, err := json.Marshal(env)
	if err != nil {
		return err
	}

	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	tmp := path + ".tmp"
	f, err := os.OpenFile(tmp, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	if _, err := f.Write(data); err != nil {
		_ = f.Close()
		_ = os.Remove(tmp)
		return err
	}
	if err := f.Sync(); err != nil {
		_ = f.Close()
		_ = os.Remove(tmp)
		return err
	}
	if err := f.Close(); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return syncDir(dir)
}

// LoadSnapshot reads a previously saved snapshot from path.
func LoadSnapshot(path string) (*Snapshot, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var env diskEnvelope
	if err := json.Unmarshal(data, &env); err != nil {
		return nil, err
	}
	if env.SchemaVersion != diskSchemaVersion {
		return nil, fmt.Errorf("unsupported snapshot schema_version %d", env.SchemaVersion)
	}
	snap := &Snapshot{
		HighWaterVersion: env.HighWaterVersion,
		Scores:           make(map[string]ScoreEntry, len(env.Scores)),
		Keys:             make(map[string]KeyEntry, len(env.Keys)),
		Policy:           env.Policy,
	}
	for _, s := range env.Scores {
		snap.Scores[s.PrincipalID] = ScoreEntry(s)
	}
	for _, k := range env.Keys {
		raw, err := DecodePublicKeyRaw(k.PublicKeyRaw)
		if err != nil {
			return nil, err
		}
		vf, err := parseTime(k.ValidFrom)
		if err != nil {
			return nil, err
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
	if snap.Policy != nil && snap.Policy.MaxSnapshotAgeSeconds > 0 {
		snap.Policy.MaxSnapshotAgeSeconds = clampAge(snap.Policy.MaxSnapshotAgeSeconds)
	}
	return snap, nil
}

func syncDir(dir string) error {
	d, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer d.Close()
	return d.Sync()
}
