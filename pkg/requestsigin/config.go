package requestsigin

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"sync"
)

type AgentEntry struct {
	DID         string   `json:"did"`
	KeyLabel    string   `json:"key_label"`
	PublicKeyB64 string  `json:"public_key"`
	AllowedURIs []string `json:"allowed_uris,omitempty"`
}

type AgentRegistry struct {
	mu    sync.RWMutex
	byKey map[string]*AgentEntry
	byDID map[string][]*AgentEntry
}

func NewAgentRegistry() *AgentRegistry {
	return &AgentRegistry{
		byKey: make(map[string]*AgentEntry),
		byDID: make(map[string][]*AgentEntry),
	}
}

func (r *AgentRegistry) LoadFromJSON(path string) error {
	data, err := os.ReadFile(path)
	if err != nil {
		return fmt.Errorf("failed to read registry file: %w", err)
	}

	var entries []AgentEntry
	if err := json.Unmarshal(data, &entries); err != nil {
		return fmt.Errorf("failed to parse registry JSON: %w", err)
	}

	for i := range entries {
		if err := r.Register(&entries[i]); err != nil {
			return fmt.Errorf("failed to register entry %d: %w", i, err)
		}
	}
	return nil
}

func (r *AgentRegistry) SaveToJSON(path string) error {
	r.mu.RLock()
	defer r.mu.RUnlock()

	seen := make(map[string]bool)
	var entries []AgentEntry
	for _, e := range r.byKey {
		if !seen[e.DID+":"+e.KeyLabel] {
			seen[e.DID+":"+e.KeyLabel] = true
			entries = append(entries, *e)
		}
	}

	data, err := json.MarshalIndent(entries, "", "  ")
	if err != nil {
		return fmt.Errorf("failed to marshal registry: %w", err)
	}

	if err := os.WriteFile(path, data, 0600); err != nil {
		return fmt.Errorf("failed to write registry file: %w", err)
	}
	return nil
}

func (r *AgentRegistry) Register(entry *AgentEntry) error {
	if entry.DID == "" || entry.KeyLabel == "" {
		return fmt.Errorf("did and key_label are required")
	}

	keyID := fmt.Sprintf("vrl:agent:%s:%s", entry.DID, entry.KeyLabel)

	r.mu.Lock()
	defer r.mu.Unlock()

	r.byKey[keyID] = entry
	r.byDID[entry.DID] = append(r.byDID[entry.DID], entry)
	return nil
}

func (r *AgentRegistry) Lookup(keyid string) (*AgentEntry, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()

	entry, ok := r.byKey[keyid]
	if !ok {
		return nil, fmt.Errorf("key not found: %s", keyid)
	}
	return entry, nil
}

func (r *AgentRegistry) LookupByDID(did string) ([]*AgentEntry, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()

	entries, ok := r.byDID[did]
	if !ok || len(entries) == 0 {
		return nil, fmt.Errorf("no entries found for DID: %s", did)
	}
	return entries, nil
}

func (r *AgentRegistry) GetPublicKey(keyid string) (ed25519.PublicKey, error) {
	entry, err := r.Lookup(keyid)
	if err != nil {
		return nil, err
	}

	pubBytes, err := base64.RawURLEncoding.DecodeString(entry.PublicKeyB64)
	if err != nil {
		return nil, fmt.Errorf("invalid public key encoding: %w", err)
	}

	if len(pubBytes) != ed25519.PublicKeySize {
		return nil, fmt.Errorf("invalid public key length: got %d, want %d", len(pubBytes), ed25519.PublicKeySize)
	}

	return ed25519.PublicKey(pubBytes), nil
}

func parseKeyID(keyid string) (did, label string, ok bool) {
	const prefix = "vrl:agent:"
	if !strings.HasPrefix(keyid, prefix) {
		return "", "", false
	}
	rest := keyid[len(prefix):]
	parts := strings.Split(rest, ":")
	if len(parts) < 4 {
		return "", "", false
	}
	did = strings.Join(parts[:3], ":")
	label = strings.Join(parts[3:], ":")
	if did == "" || label == "" {
		return "", "", false
	}
	return did, label, true
}
