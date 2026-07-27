package requestsigin

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"strconv"
	"strings"
)

type SignatureInput struct {
	KeyID   string
	Created int64
	Expires int64
	Nonce   string
	Tag     string
}

func ComputeKeyHash(pub ed25519.PublicKey) string {
	h := sha256.Sum256(pub)
	return base64.RawURLEncoding.EncodeToString(h[:])
}

func ComputeContentDigest(body []byte) string {
	h := sha256.Sum256(body)
	return "sha-256=:" + base64.RawURLEncoding.EncodeToString(h[:]) + ":"
}

func BuildSignatureBase(method, targetURI string, created, expires int64, body []byte) string {
	var sb strings.Builder
	sb.WriteString(fmt.Sprintf("\"@method\": %s\n", method))
	sb.WriteString(fmt.Sprintf("\"@target-uri\": %s\n", targetURI))
	sb.WriteString(fmt.Sprintf("\"@created\": %d\n", created))
	sb.WriteString(fmt.Sprintf("\"@expires\": %d\n", expires))
	if len(body) > 0 {
		sb.WriteString(fmt.Sprintf("\"content-digest\": %s\n", ComputeContentDigest(body)))
	}
	return sb.String()
}

func Sign(method, targetURI string, created, expires int64, body []byte, keyID string, privateKey ed25519.PrivateKey) (sigInput, signature string, err error) {
	sigBase := BuildSignatureBase(method, targetURI, created, expires, body)

	components := "\"@method\" \"@target-uri\" \"@created\" \"@expires\""
	if len(body) > 0 {
		components += " \"content-digest\""
	}

	sigInput = fmt.Sprintf("%s;keyid=%q;created=%d;expires=%d", components, keyID, created, expires)

	sigBytes := ed25519.Sign(privateKey, []byte(sigBase))
	signature = base64.RawURLEncoding.EncodeToString(sigBytes)

	return sigInput, signature, nil
}

func Verify(sigBase, sigB64 string, pub ed25519.PublicKey) error {
	sigBytes, err := base64.RawURLEncoding.DecodeString(sigB64)
	if err != nil {
		return fmt.Errorf("invalid signature encoding: %w", err)
	}

	if !ed25519.Verify(pub, []byte(sigBase), sigBytes) {
		return fmt.Errorf("signature verification failed")
	}

	return nil
}

func VerifySignatureInput(sigInputHeader, sigHeader, method, targetURI string, getBody func() []byte, lookupKey func(keyid string) (ed25519.PublicKey, error)) error {
	si, err := parseSignatureInput(sigInputHeader)
	if err != nil {
		return err
	}

	body := getBody()

	sigBase := BuildSignatureBase(method, targetURI, si.Created, si.Expires, body)

	pub, err := lookupKey(si.KeyID)
	if err != nil {
		return fmt.Errorf("key lookup failed: %w", err)
	}

	return Verify(sigBase, sigHeader, pub)
}

func parseSignatureInput(header string) (*SignatureInput, error) {
	si := &SignatureInput{}

	parts := strings.Split(header, ";")
	if len(parts) == 0 {
		return nil, fmt.Errorf("empty signature-input header")
	}

	for _, part := range parts[1:] {
		kv := strings.SplitN(strings.TrimSpace(part), "=", 2)
		if len(kv) != 2 {
			continue
		}
		key := kv[0]
		val := strings.Trim(kv[1], `"`)

		switch key {
		case "keyid":
			si.KeyID = val
		case "created":
			v, err := strconv.ParseInt(val, 10, 64)
			if err != nil {
				return nil, fmt.Errorf("invalid created: %w", err)
			}
			si.Created = v
		case "expires":
			v, err := strconv.ParseInt(val, 10, 64)
			if err != nil {
				return nil, fmt.Errorf("invalid expires: %w", err)
			}
			si.Expires = v
		case "nonce":
			si.Nonce = val
		case "tag":
			si.Tag = val
		}
	}

	if si.KeyID == "" {
		return nil, fmt.Errorf("missing keyid in signature-input")
	}

	return si, nil
}
