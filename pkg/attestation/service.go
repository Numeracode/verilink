package attestation

import (
	"crypto/ed25519"
	"fmt"
	"sync"

	"github.com/golang-jwt/jwt/v5"
)

// Service handles the management and verification of attestations.
type Service struct {
	mu           sync.RWMutex
	issuers      map[string]ed25519.PublicKey // issuer_did -> public_key
	attestations []string                     // list of verified JWS tokens
}

// NewService creates a new AttestationService.
func NewService() *Service {
	return &Service{
		issuers:      make(map[string]ed25519.PublicKey),
		attestations: []string{},
	}
}

// RegisterIssuer adds a trusted public key for an issuer.
func (s *Service) RegisterIssuer(did string, pubKey ed25519.PublicKey) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.issuers[did] = pubKey
}

// SubmitAttestation verifies and stores a new behavioural attestation.
func (s *Service) SubmitAttestation(tokenString string) error {
	_, err := s.VerifyAndPeekIssuer(tokenString)
	if err != nil {
		return fmt.Errorf("attestation verification failed: %w", err)
	}

	// Store the verified attestation
	s.mu.Lock()
	s.attestations = append(s.attestations, tokenString)
	s.mu.Unlock()

	return nil
}

// VerifyAndPeekIssuer is the safe public API for verifying a token and returning its claims.
// It retrieves the registered public key for the issuer and performs full signature verification.
func (s *Service) VerifyAndPeekIssuer(tokenString string) (*AttestationClaims, error) {
	// 1. Peek to get issuer (unverified parse)
	claims, err := s.peekIssuer(tokenString)
	if err != nil {
		return nil, fmt.Errorf("invalid attestation format: %w", err)
	}

	// 2. Lookup public key from registry
	s.mu.RLock()
	pubKey, ok := s.issuers[claims.Issuer]
	s.mu.RUnlock()

	if !ok {
		return nil, fmt.Errorf("untrusted issuer: %s", claims.Issuer)
	}

	// 3. Full signature verification
	return Verify(tokenString, pubKey)
}

// GetAttestations returns all stored, verified attestations.
func (s *Service) GetAttestations() []string {
	s.mu.RLock()
	defer s.mu.RUnlock()

	result := make([]string, len(s.attestations))
	copy(result, s.attestations)
	return result
}

// peekIssuer is internal and unmarshals the JWT claims without verifying the signature.
// This is unsafe for external use and must be followed by full signature verification.
func (s *Service) peekIssuer(tokenString string) (*AttestationClaims, error) {
	var claims AttestationClaims
	parser := jwt.NewParser()
	_, _, err := parser.ParseUnverified(tokenString, &claims)
	if err != nil {
		return nil, err
	}
	return &claims, nil
}
