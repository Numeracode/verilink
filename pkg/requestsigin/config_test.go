package requestsigin

import (
	"crypto/ed25519"
	"encoding/base64"
	"os"
	"path/filepath"
	"testing"
)

func TestAgentRegistry_RegisterAndLookup(t *testing.T) {
	tests := []struct {
		name  string
		entry *AgentEntry
		keyID string
	}{
		{
			name: "single agent",
			entry: &AgentEntry{
				DID:          "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK",
				KeyLabel:     "signing-key-1",
				PublicKeyB64: base64.RawURLEncoding.EncodeToString(make([]byte, ed25519.PublicKeySize)),
			},
			keyID: "vrl:agent:did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK|signing-key-1",
		},
		{
			name: "agent with allowed URIs",
			entry: &AgentEntry{
				DID:          "did:web:example.com",
				KeyLabel:     "prod-key",
				PublicKeyB64: base64.RawURLEncoding.EncodeToString(make([]byte, ed25519.PublicKeySize)),
				AllowedURIs:  []string{"/api/v1/*", "/health"},
			},
			keyID: "vrl:agent:did:web:example.com|prod-key",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			r := NewAgentRegistry()
			if err := r.Register(tt.entry); err != nil {
				t.Fatalf("Register failed: %v", err)
			}

			got, err := r.Lookup(tt.keyID)
			if err != nil {
				t.Fatalf("Lookup failed: %v", err)
			}

			if got.DID != tt.entry.DID {
				t.Errorf("DID = %q, want %q", got.DID, tt.entry.DID)
			}
			if got.KeyLabel != tt.entry.KeyLabel {
				t.Errorf("KeyLabel = %q, want %q", got.KeyLabel, tt.entry.KeyLabel)
			}
			if got.PublicKeyB64 != tt.entry.PublicKeyB64 {
				t.Errorf("PublicKeyB64 = %q, want %q", got.PublicKeyB64, tt.entry.PublicKeyB64)
			}
		})
	}
}

func TestAgentRegistry_LookupNotFound(t *testing.T) {
	tests := []struct {
		name  string
		keyID string
	}{
		{"empty registry", "vrl:agent:did:key:z123|missing"},
		{"wrong DID", "vrl:agent:did:web:unknown.com|key"},
		{"wrong label", "vrl:agent:did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK|nonexistent"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			r := NewAgentRegistry()
			_, err := r.Lookup(tt.keyID)
			if err == nil {
				t.Errorf("expected error for keyID %q, got nil", tt.keyID)
			}
		})
	}
}

func TestAgentRegistry_LookupByDID(t *testing.T) {
	did := "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK"
	entries := []*AgentEntry{
		{DID: did, KeyLabel: "key-1", PublicKeyB64: base64.RawURLEncoding.EncodeToString(make([]byte, ed25519.PublicKeySize))},
		{DID: did, KeyLabel: "key-2", PublicKeyB64: base64.RawURLEncoding.EncodeToString(make([]byte, ed25519.PublicKeySize))},
		{DID: did, KeyLabel: "key-3", PublicKeyB64: base64.RawURLEncoding.EncodeToString(make([]byte, ed25519.PublicKeySize))},
	}

	r := NewAgentRegistry()
	for _, e := range entries {
		if err := r.Register(e); err != nil {
			t.Fatalf("Register failed: %v", err)
		}
	}

	got, err := r.LookupByDID(did)
	if err != nil {
		t.Fatalf("LookupByDID failed: %v", err)
	}

	if len(got) != 3 {
		t.Fatalf("expected 3 entries, got %d", len(got))
	}

	// Verify a different DID returns error
	_, err = r.LookupByDID("did:web:unknown.com")
	if err == nil {
		t.Error("expected error for unknown DID, got nil")
	}
}

func TestAgentRegistry_GetPublicKey(t *testing.T) {
	pubKey, _, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatalf("GenerateKey failed: %v", err)
	}

	entry := &AgentEntry{
		DID:          "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK",
		KeyLabel:     "test-key",
		PublicKeyB64: base64.RawURLEncoding.EncodeToString(pubKey),
	}

	r := NewAgentRegistry()
	if err := r.Register(entry); err != nil {
		t.Fatalf("Register failed: %v", err)
	}

	keyID := "vrl:agent:did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK|test-key"
	got, err := r.GetPublicKey(keyID)
	if err != nil {
		t.Fatalf("GetPublicKey failed: %v", err)
	}

	if len(got) != ed25519.PublicKeySize {
		t.Errorf("key length = %d, want %d", len(got), ed25519.PublicKeySize)
	}
	for i := range got {
		if got[i] != pubKey[i] {
			t.Errorf("key mismatch at byte %d", i)
			break
		}
	}
}

func TestAgentRegistry_GetPublicKeyInvalid(t *testing.T) {
	tests := []struct {
		name         string
		publicKeyB64 string
	}{
		{"invalid base64", "!!!not-valid-base64!!!"},
		{"wrong length", base64.RawURLEncoding.EncodeToString(make([]byte, 16))},
		{"empty string", ""},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			entry := &AgentEntry{
				DID:          "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK",
				KeyLabel:     "bad-key",
				PublicKeyB64: tt.publicKeyB64,
			}

			r := NewAgentRegistry()
			if err := r.Register(entry); err != nil {
				t.Fatalf("Register failed: %v", err)
			}

			keyID := "vrl:agent:did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK|bad-key"
			_, err := r.GetPublicKey(keyID)
			if err == nil {
				t.Errorf("expected error for %s, got nil", tt.name)
			}
		})
	}
}

func TestAgentRegistry_SaveAndLoadJSON(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "registry.json")

	entries := []*AgentEntry{
		{DID: "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK", KeyLabel: "key-1", PublicKeyB64: base64.RawURLEncoding.EncodeToString(make([]byte, ed25519.PublicKeySize))},
		{DID: "did:web:example.com", KeyLabel: "prod", PublicKeyB64: base64.RawURLEncoding.EncodeToString(make([]byte, ed25519.PublicKeySize))},
	}

	original := NewAgentRegistry()
	for _, e := range entries {
		if err := original.Register(e); err != nil {
			t.Fatalf("Register failed: %v", err)
		}
	}

	if err := original.SaveToJSON(path); err != nil {
		t.Fatalf("SaveToJSON failed: %v", err)
	}

	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("ReadFile failed: %v", err)
	}
	if len(data) == 0 {
		t.Fatal("saved file is empty")
	}

	loaded := NewAgentRegistry()
	if err := loaded.LoadFromJSON(path); err != nil {
		t.Fatalf("LoadFromJSON failed: %v", err)
	}

	for _, e := range entries {
		keyID := "vrl:agent:" + e.DID + "|" + e.KeyLabel
		got, err := loaded.Lookup(keyID)
		if err != nil {
			t.Errorf("Lookup(%q) after load failed: %v", keyID, err)
			continue
		}
		if got.DID != e.DID {
			t.Errorf("DID = %q, want %q", got.DID, e.DID)
		}
		if got.KeyLabel != e.KeyLabel {
			t.Errorf("KeyLabel = %q, want %q", got.KeyLabel, e.KeyLabel)
		}
	}
}

func TestAgentRegistry_KeyIDFormat(t *testing.T) {
	tests := []struct {
		name    string
		keyID   string
		wantDID string
		wantLbl string
		wantOK  bool
	}{
		{"valid format", "vrl:agent:did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK|signing-key-1", "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK", "signing-key-1", true},
		{"web DID", "vrl:agent:did:web:example.com|prod-key", "did:web:example.com", "prod-key", true},
		{"label with colons", "vrl:agent:did:key:z123|a:b:c", "did:key:z123", "a:b:c", true},
		{"missing prefix", "agent:did:key:z123|key", "", "", false},
		{"empty DID", "vrl:agent:|key", "", "", false},
		{"empty label", "vrl:agent:did:key:z123|", "", "", false},
		{"no separator", "vrl:agent:did:key:z123", "", "", false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			did, label, ok := parseKeyID(tt.keyID)
			if ok != tt.wantOK {
				t.Errorf("parseKeyID(%q) ok = %v, want %v", tt.keyID, ok, tt.wantOK)
			}
			if ok && did != tt.wantDID {
				t.Errorf("parseKeyID(%q) did = %q, want %q", tt.keyID, did, tt.wantDID)
			}
			if ok && label != tt.wantLbl {
				t.Errorf("parseKeyID(%q) label = %q, want %q", tt.keyID, label, tt.wantLbl)
			}
		})
	}
}
