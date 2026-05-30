package verifier

import (
	"errors"
	"sync"
)

// TrustScore represents the level of trust for an agent (0-100).
type TrustScore int

const (
	TrustThreshold TrustScore = 50 // Minimum score to allow access
)

// TrustStore defines the interface for querying trust status of a fingerprint.
type TrustStore interface {
	GetTrustScore(fingerprint string) (TrustScore, error)
}

// MockTrustStore is a simple in-memory implementation for testing and MVP.
type MockTrustStore struct {
	mu     sync.RWMutex
	scores map[string]TrustScore
}

// NewMockTrustStore creates a new in-memory trust store for testing and MVP.
func NewMockTrustStore() *MockTrustStore {
	return &MockTrustStore{
		scores: make(map[string]TrustScore),
	}
}

// SetTrustScore stores a trust score for a fingerprint.
func (m *MockTrustStore) SetTrustScore(fingerprint string, score TrustScore) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.scores[fingerprint] = score
	return nil
}

// GetTrustScore retrieves the trust score for a fingerprint.
func (m *MockTrustStore) GetTrustScore(fingerprint string) (TrustScore, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	score, ok := m.scores[fingerprint]
	if !ok {
		return 0, errors.New("fingerprint not found")
	}
	return score, nil
}

// DeleteTrustScore removes a fingerprint from the trust store.
func (m *MockTrustStore) DeleteTrustScore(fingerprint string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.scores, fingerprint)
	return nil
}

// ListTrustFingerprints returns all fingerprints stored in the trust store.
func (m *MockTrustStore) ListTrustFingerprints() ([]string, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	var fingerprints []string
	for fp := range m.scores {
		fingerprints = append(fingerprints, fp)
	}
	return fingerprints, nil
}
