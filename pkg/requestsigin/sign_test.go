package requestsigin

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"strings"
	"testing"
	"time"
)

func TestComputeKeyHash(t *testing.T) {
	pub1, _, _ := ed25519.GenerateKey(rand.Reader)
	pub2, _, _ := ed25519.GenerateKey(rand.Reader)

	h1 := ComputeKeyHash(pub1)
	h2 := ComputeKeyHash(pub1)
	h3 := ComputeKeyHash(pub2)

	if h1 != h2 {
		t.Errorf("same key produced different hashes: %s vs %s", h1, h2)
	}
	if h1 == h3 {
		t.Error("different keys produced same hash")
	}
	if len(h1) == 0 {
		t.Error("empty hash")
	}
}

func TestBuildSignatureBase(t *testing.T) {
	method := "POST"
	uri := "https://example.com/api"
	var created int64 = 1234567890
	var expires int64 = 1234567950
	body := []byte(`{"msg":"hello"}`)

	base := BuildSignatureBase(method, uri, created, expires, body)

	if base == "" {
		t.Fatal("empty signature base")
	}
	for _, want := range []string{
		`"@method": POST`,
		`"@target-uri": https://example.com/api`,
		`"@created": 1234567890`,
		`"@expires": 1234567950`,
		`"content-digest": sha-256=:`,
	} {
		if !strings.Contains(base, want) {
			t.Errorf("signature base missing %q", want)
		}
	}
}

func TestBuildSignatureBaseNoBody(t *testing.T) {
	method := "GET"
	uri := "https://example.com/resource"
	var created int64 = 100
	var expires int64 = 200

	base := BuildSignatureBase(method, uri, created, expires, nil)

	if strings.Contains(base, "content-digest") {
		t.Error("signature base should not contain content-digest for nil body")
	}
}

func TestSignAndVerify(t *testing.T) {
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	keyID := "test-key-1"
	method := "POST"
	uri := "https://example.com/api"
	now := time.Now().Unix()
	created := now
	expires := now + 300
	body := []byte(`{"data":"test"}`)

	sigInput, sig, err := Sign(method, uri, created, expires, body, keyID, priv)
	if err != nil {
		t.Fatalf("Sign failed: %v", err)
	}
	if sigInput == "" {
		t.Fatal("empty sigInput")
	}
	if sig == "" {
		t.Fatal("empty signature")
	}

	sigBase := BuildSignatureBase(method, uri, created, expires, body)
	err = Verify(sigBase, sig, pub)
	if err != nil {
		t.Fatalf("Verify failed: %v", err)
	}

	tampered := sig[:len(sig)-2] + "XX"
	err = Verify(sigBase, tampered, pub)
	if err == nil {
		t.Error("Verify should fail with tampered signature")
	}
}

func TestVerifyWrongKeyLength(t *testing.T) {
	err := Verify("base", "sig", ed25519.PublicKey(make([]byte, 10)))
	if err == nil {
		t.Fatal("expected error for wrong key length")
	}
	if !strings.Contains(err.Error(), "invalid public key length") {
		t.Errorf("unexpected error: %v", err)
	}
}

func TestVerifySignatureInput(t *testing.T) {
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	keyID := "k1"
	method := "POST"
	uri := "https://example.com/hook"
	now := time.Now().Unix()
	created := now
	expires := now + 300
	body := []byte(`{"ok":true}`)

	sigInput, sig, err := Sign(method, uri, created, expires, body, keyID, priv)
	if err != nil {
		t.Fatalf("Sign: %v", err)
	}

	lookupKey := func(kid string) (ed25519.PublicKey, error) {
		if kid == keyID {
			return pub, nil
		}
		return nil, fmt.Errorf("unknown keyid: %s", kid)
	}

	getBody := func() []byte { return body }

	err = VerifySignatureInput(sigInput, sig, method, uri, getBody, lookupKey)
	if err != nil {
		t.Fatalf("VerifySignatureInput: %v", err)
	}

	err = VerifySignatureInput(sigInput, "tampered", method, uri, getBody, lookupKey)
	if err == nil {
		t.Error("should fail with bad signature")
	}
}

func TestVerifySignatureInputUnknownKeyID(t *testing.T) {
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	keyID := "known-key"
	method := "GET"
	uri := "https://example.com/hook"
	now := time.Now().Unix()
	created := now
	expires := now + 300

	sigInput, sig, err := Sign(method, uri, created, expires, nil, keyID, priv)
	if err != nil {
		t.Fatalf("Sign: %v", err)
	}

	lookupKey := func(kid string) (ed25519.PublicKey, error) {
		if kid == "unknown-key" {
			return pub, nil
		}
		return nil, fmt.Errorf("unknown keyid: %s", kid)
	}

	err = VerifySignatureInput(sigInput, sig, method, uri, func() []byte { return nil }, lookupKey)
	if err == nil {
		t.Fatal("expected error for unknown keyid")
	}
	if !strings.Contains(err.Error(), "key lookup failed") {
		t.Errorf("unexpected error: %v", err)
	}
}

func TestVerifySignatureInputExpired(t *testing.T) {
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	keyID := "exp-key"
	method := "GET"
	uri := "https://example.com/api"
	created := time.Now().Unix() - 600
	expires := created + 60

	sigInput, sig, err := Sign(method, uri, created, expires, nil, keyID, priv)
	if err != nil {
		t.Fatalf("Sign: %v", err)
	}

	err = VerifySignatureInput(sigInput, sig, method, uri, func() []byte { return nil }, func(string) (ed25519.PublicKey, error) { return pub, nil })
	if err == nil {
		t.Fatal("expected error for expired signature")
	}
	if !strings.Contains(err.Error(), "expired") {
		t.Errorf("unexpected error: %v", err)
	}
}

func TestVerifySignatureInputFutureCreated(t *testing.T) {
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	keyID := "future-key"
	method := "GET"
	uri := "https://example.com/api"
	created := time.Now().Unix() + 600
	expires := created + 60

	sigInput, sig, err := Sign(method, uri, created, expires, nil, keyID, priv)
	if err != nil {
		t.Fatalf("Sign: %v", err)
	}

	err = VerifySignatureInput(sigInput, sig, method, uri, func() []byte { return nil }, func(string) (ed25519.PublicKey, error) { return pub, nil })
	if err == nil {
		t.Fatal("expected error for future-dated signature")
	}
	if !strings.Contains(err.Error(), "future") {
		t.Errorf("unexpected error: %v", err)
	}
}

func TestVerifySignatureInputWindowTooWide(t *testing.T) {
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	keyID := "wide-key"
	method := "GET"
	uri := "https://example.com/api"
	now := time.Now().Unix()
	created := now
	expires := now + 600

	sigInput, sig, err := Sign(method, uri, created, expires, nil, keyID, priv)
	if err != nil {
		t.Fatalf("Sign: %v", err)
	}

	err = VerifySignatureInput(sigInput, sig, method, uri, func() []byte { return nil }, func(string) (ed25519.PublicKey, error) { return pub, nil })
	if err == nil {
		t.Fatal("expected error for too-wide validity window")
	}
	if !strings.Contains(err.Error(), "validity window") {
		t.Errorf("unexpected error: %v", err)
	}
}

func TestComputeContentDigest(t *testing.T) {
	d1 := ComputeContentDigest(nil)
	d2 := ComputeContentDigest([]byte{})
	d3 := ComputeContentDigest([]byte("hello"))

	if d1 != d2 {
		t.Errorf("nil and empty body should produce same digest: %s vs %s", d1, d2)
	}
	if d1 == d3 {
		t.Error("different bodies produced same digest")
	}
	if len(d1) == 0 {
		t.Error("empty digest")
	}
	if !strings.Contains(d1, "sha-256=:") {
		t.Errorf("digest missing prefix: %s", d1)
	}
}

func TestSignIncludesNonce(t *testing.T) {
	_, priv, _ := ed25519.GenerateKey(rand.Reader)
	now := time.Now().Unix()
	sigInput, _, err := Sign("GET", "https://example.com", now, now+300, nil, "k1", priv)
	if err != nil {
		t.Fatalf("Sign: %v", err)
	}
	if !strings.Contains(sigInput, "nonce=") {
		t.Errorf("sigInput missing nonce: %s", sigInput)
	}
}

func TestParseSignatureInputEmpty(t *testing.T) {
	_, err := parseSignatureInput("")
	if err == nil {
		t.Fatal("expected error for empty header")
	}
	_, err = parseSignatureInput("   ")
	if err == nil {
		t.Fatal("expected error for whitespace-only header")
	}
}

func TestComputeKeyHashBase64(t *testing.T) {
	pub, _, _ := ed25519.GenerateKey(rand.Reader)
	h := ComputeKeyHash(pub)
	decoded, err := base64.RawURLEncoding.DecodeString(h)
	if err != nil {
		t.Fatalf("hash not valid base64url: %v", err)
	}
	if len(decoded) != 32 {
		t.Errorf("expected 32-byte hash, got %d", len(decoded))
	}
}
