package attestation

import (
	"crypto/ed25519"
	"fmt"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// VerilinkClaims represents the behavioural facts in an attestation.
type VerilinkClaims struct {
	Type            string                 `json:"type"`
	Facts           map[string]interface{} `json:"facts"`
	TrustLevelDelta int                    `json:"trust_level_delta"`
	SchemaVersion   string                 `json:"schema_version,omitempty"`
	Visibility      string                 `json:"visibility,omitempty"`
	ObservationID   string                 `json:"observation_id,omitempty"`
}

// AttestationClaims is the standard JWT claims combined with Verilink facts.
type AttestationClaims struct {
	VerilinkClaims VerilinkClaims `json:"vli"`
	jwt.RegisteredClaims
}

// Sign creates a cryptographically signed JWS (JSON Web Signature) attestation.
func Sign(issuer string, subject string, vli VerilinkClaims, privateKey ed25519.PrivateKey) (string, error) {
	claims := AttestationClaims{
		VerilinkClaims: vli,
		RegisteredClaims: jwt.RegisteredClaims{
			Issuer:    issuer,
			Subject:   subject,
			IssuedAt:  jwt.NewNumericDate(time.Now()),
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(365 * 24 * time.Hour)), // Stale after 1 year by default
		},
	}

	token := jwt.NewWithClaims(jwt.SigningMethodEdDSA, claims)
	signedToken, err := token.SignedString(privateKey)
	if err != nil {
		return "", fmt.Errorf("failed to sign attestation: %w", err)
	}

	return signedToken, nil
}

// Verify decodes and validates a JWS attestation against an expected public key.
func Verify(tokenString string, publicKey ed25519.PublicKey) (*AttestationClaims, error) {
	token, err := jwt.ParseWithClaims(tokenString, &AttestationClaims{}, func(token *jwt.Token) (interface{}, error) {
		if _, ok := token.Method.(*jwt.SigningMethodEd25519); !ok {
			return nil, fmt.Errorf("unexpected signing method: %v", token.Header["alg"])
		}
		return publicKey, nil
	})

	if err != nil {
		return nil, fmt.Errorf("failed to verify attestation: %w", err)
	}

	if claims, ok := token.Claims.(*AttestationClaims); ok && token.Valid {
		return claims, nil
	}

	return nil, fmt.Errorf("invalid attestation")
}
