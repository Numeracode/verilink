package requestsigin

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"strconv"
	"strings"
	"time"
)

const (
	maxSkewSeconds    int64 = 30
	maxValidityWindow int64 = 300
)

type SignatureInput struct {
	KeyID      string
	Created    int64
	Expires    int64
	Nonce      string
	Tag        string
	Components []string
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
	fmt.Fprintf(&sb, "\"@method\": %s\n", method)
	fmt.Fprintf(&sb, "\"@target-uri\": %s\n", targetURI)
	fmt.Fprintf(&sb, "\"@created\": %d\n", created)
	fmt.Fprintf(&sb, "\"@expires\": %d\n", expires)
	if len(body) > 0 {
		fmt.Fprintf(&sb, "\"content-digest\": %s\n", ComputeContentDigest(body))
	}
	return sb.String()
}

func Sign(method, targetURI string, created, expires int64, body []byte, keyID string, privateKey ed25519.PrivateKey) (sigInput, signature string, err error) {
	sigBase := BuildSignatureBase(method, targetURI, created, expires, body)

	components := "\"@method\" \"@target-uri\" \"@created\" \"@expires\""
	if len(body) > 0 {
		components += " \"content-digest\""
	}

	nonce, err := generateNonce()
	if err != nil {
		return "", "", fmt.Errorf("generate nonce: %w", err)
	}

	sigInput = fmt.Sprintf("%s;keyid=%q;created=%d;expires=%d;nonce=%s", components, keyID, created, expires, nonce)

	sigBytes := ed25519.Sign(privateKey, []byte(sigBase))
	signature = base64.RawURLEncoding.EncodeToString(sigBytes)

	return sigInput, signature, nil
}

// ExtraComponent is an additional header to include in the signature base.
type ExtraComponent struct {
	Name  string
	Value string
}

// BuildSignatureBaseWithExtra builds the signature base string with additional
// header components appended after the standard derived components.
func BuildSignatureBaseWithExtra(method, targetURI string, created, expires int64, body []byte, extra []ExtraComponent) string {
	base := BuildSignatureBase(method, targetURI, created, expires, body)
	var sb strings.Builder
	sb.WriteString(base)
	for _, c := range extra {
		fmt.Fprintf(&sb, "%q: %s\n", c.Name, c.Value)
	}
	return sb.String()
}

// SignWithExtra signs a request with additional covered components (e.g.
// Idempotency-Key). The extra components are appended to both the signature
// base and the covered-component list in Signature-Input.
func SignWithExtra(method, targetURI string, created, expires int64, body []byte, keyID string, privateKey ed25519.PrivateKey, extra []ExtraComponent) (sigInput, signature string, err error) {
	sigBase := BuildSignatureBaseWithExtra(method, targetURI, created, expires, body, extra)

	components := "\"@method\" \"@target-uri\" \"@created\" \"@expires\""
	if len(body) > 0 {
		components += " \"content-digest\""
	}
	for _, c := range extra {
		components += fmt.Sprintf(" %q", c.Name)
	}

	nonce, err := generateNonce()
	if err != nil {
		return "", "", fmt.Errorf("generate nonce: %w", err)
	}

	sigInput = fmt.Sprintf("%s;keyid=%q;created=%d;expires=%d;nonce=%s", components, keyID, created, expires, nonce)

	sigBytes := ed25519.Sign(privateKey, []byte(sigBase))
	signature = base64.RawURLEncoding.EncodeToString(sigBytes)

	return sigInput, signature, nil
}

func Verify(sigBase, sigB64 string, pub ed25519.PublicKey) error {
	if len(pub) != ed25519.PublicKeySize {
		return fmt.Errorf("invalid public key length: %d", len(pub))
	}

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

	now := time.Now().Unix()

	if si.Created > 0 && now < si.Created-maxSkewSeconds {
		return fmt.Errorf("signature created in the future: created=%d now=%d", si.Created, now)
	}
	if si.Expires > 0 && now > si.Expires+maxSkewSeconds {
		return fmt.Errorf("signature expired: expires=%d now=%d", si.Expires, now)
	}
	if si.Created > 0 && si.Expires > 0 && si.Expires-si.Created > maxValidityWindow {
		return fmt.Errorf("validity window exceeds %d seconds", maxValidityWindow)
	}
	if si.Nonce == "" {
		return fmt.Errorf("missing nonce in signature-input")
	}

	body := getBody()

	sigBase := BuildSignatureBase(method, targetURI, si.Created, si.Expires, body)

	pub, err := lookupKey(si.KeyID)
	if err != nil {
		return fmt.Errorf("key lookup failed: %w", err)
	}

	return Verify(sigBase, sigHeader, pub)
}

// VerifySignatureInputWithExtra verifies a signature that may include extra
// header components (e.g. Idempotency-Key). getExtraHeader returns the value
// for a given header name, or empty string if not present.
func VerifySignatureInputWithExtra(sigInputHeader, sigHeader, method, targetURI string, getBody func() []byte, lookupKey func(keyid string) (ed25519.PublicKey, error), getExtraHeader func(name string) string) error {
	si, err := parseSignatureInput(sigInputHeader)
	if err != nil {
		return err
	}

	now := time.Now().Unix()

	if si.Created > 0 && now < si.Created-maxSkewSeconds {
		return fmt.Errorf("signature created in the future: created=%d now=%d", si.Created, now)
	}
	if si.Expires > 0 && now > si.Expires+maxSkewSeconds {
		return fmt.Errorf("signature expired: expires=%d now=%d", si.Expires, now)
	}
	if si.Created > 0 && si.Expires > 0 && si.Expires-si.Created > maxValidityWindow {
		return fmt.Errorf("validity window exceeds %d seconds", maxValidityWindow)
	}
	if si.Nonce == "" {
		return fmt.Errorf("missing nonce in signature-input")
	}

	body := getBody()

	// Collect extra (non-derived) components
	var extra []ExtraComponent
	derived := map[string]bool{
		"@method": true, "@target-uri": true, "@created": true,
		"@expires": true, "content-digest": true,
	}
	for _, comp := range si.Components {
		if !derived[comp] {
			val := getExtraHeader(comp)
			extra = append(extra, ExtraComponent{Name: comp, Value: val})
		}
	}

	sigBase := BuildSignatureBaseWithExtra(method, targetURI, si.Created, si.Expires, body, extra)

	pub, err := lookupKey(si.KeyID)
	if err != nil {
		return fmt.Errorf("key lookup failed: %w", err)
	}

	return Verify(sigBase, sigHeader, pub)
}

func ParseSignatureInput(header string) (*SignatureInput, error) {
	return parseSignatureInput(header)
}

func parseSignatureInput(header string) (*SignatureInput, error) {
	if strings.TrimSpace(header) == "" {
		return nil, fmt.Errorf("empty signature-input header")
	}

	si := &SignatureInput{}

	parts := strings.SplitN(header, ";", 2)
	componentsStr := strings.TrimSpace(parts[0])
	if componentsStr == "" {
		return nil, fmt.Errorf("missing covered-component list in signature-input")
	}
	si.Components = parseComponentList(componentsStr)

	if len(parts) < 2 {
		return nil, fmt.Errorf("missing parameters in signature-input")
	}

	for _, part := range strings.Split(parts[1], ";") {
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

func parseComponentList(s string) []string {
	s = strings.TrimSpace(s)
	fields := strings.Fields(s)
	components := make([]string, 0, len(fields))
	for _, c := range fields {
		components = append(components, strings.Trim(c, `"`))
	}
	return components
}

func generateNonce() (string, error) {
	b := make([]byte, 16)
	for i := range b {
		b[i] = byte(time.Now().UnixNano() >> uint(uint(i)*8))
	}
	h := sha256.Sum256(b)
	return base64.RawURLEncoding.EncodeToString(h[:16]), nil
}
