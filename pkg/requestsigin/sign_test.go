package requestsigin

import (
	"crypto/ed25519"
	"crypto/rand"
	"testing"
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
		if !contains(base, want) {
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

	if contains(base, "content-digest") {
		t.Error("signature base should not contain content-digest for nil body")
	}
}

func TestSignAndVerify(t *testing.T) {
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	keyID := "test-key-1"
	method := "POST"
	uri := "https://example.com/api"
	var created int64 = 1234567890
	var expires int64 = 1234567950
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

func TestVerifySignatureInput(t *testing.T) {
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	keyID := "k1"
	method := "POST"
	uri := "https://example.com/hook"
	var created int64 = 900
	var expires int64 = 1800
	body := []byte(`{"ok":true}`)

	sigInput, sig, err := Sign(method, uri, created, expires, body, keyID, priv)
	if err != nil {
		t.Fatalf("Sign: %v", err)
	}

	lookupKey := func(kid string) (ed25519.PublicKey, error) {
		if kid == keyID {
			return pub, nil
		}
		return nil, nil
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
	if !contains(d1, "sha-256=:") {
		t.Errorf("digest missing prefix: %s", d1)
	}
}

func contains(s, sub string) bool {
	return len(s) >= len(sub) && (s == sub || len(s) > 0 && containsSubstring(s, sub))
}

func containsSubstring(s, sub string) bool {
	for i := 0; i <= len(s)-len(sub); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}
