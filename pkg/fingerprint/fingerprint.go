package fingerprint

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
)

// RequestData represents the extracted layers from an incoming API request.
type RequestData struct {
	JA4      string            `json:"ja4,omitempty"`      // TLS Fingerprint (Network Layer)
	Headers  map[string]string `json:"headers,omitempty"`  // Selected HTTP headers (Identity Layer)
	KeyHash  string            `json:"key_hash,omitempty"` // Public Key Hash (Cryptographic Layer)
	Protocol string            `json:"protocol,omitempty"` // HTTP version (Protocol Layer)
}

// Generate creates a deterministic SHA-256 fingerprint for an autonomous agent.
func Generate(data RequestData) (string, error) {
	// 1. Canonicalize the input
	canonicalData := make(map[string]interface{})

	if data.JA4 != "" {
		canonicalData["ja4"] = strings.ToLower(data.JA4)
	}

	if len(data.Headers) > 0 {
		// Canonicalize headers: sort keys and join as key:value
		var keys []string
		for k := range data.Headers {
			keys = append(keys, k)
		}
		sort.Strings(keys)

		var headerList []string
		for _, k := range keys {
			headerList = append(headerList, fmt.Sprintf("%s:%s", strings.ToLower(k), data.Headers[k]))
		}
		canonicalData["headers_hash"] = hashString(strings.Join(headerList, "|"))
	}

	if data.KeyHash != "" {
		canonicalData["key_hash"] = strings.ToLower(data.KeyHash)
	}

	if data.Protocol != "" {
		canonicalData["protocol"] = strings.ToLower(data.Protocol)
	}

	// 2. Marshal to JSON (Go's json.Marshal sorts map keys automatically)
	jsonBytes, err := json.Marshal(canonicalData)
	if err != nil {
		return "", fmt.Errorf("failed to marshal canonical data: %w", err)
	}

	// 3. Hash the canonical JSON
	hash := sha256.Sum256(jsonBytes)
	return hex.EncodeToString(hash[:]), nil
}

// hashString computes the SHA-256 hash of a string and returns it as a hex-encoded string.
func hashString(s string) string {
	h := sha256.Sum256([]byte(s))
	return hex.EncodeToString(h[:])
}
