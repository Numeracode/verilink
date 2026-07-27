# Plan 3 — Request-Auth Protocol (RFC 9421 HTTP Message Signatures)

**Depends on:** Plans 1 + 2 (merged to main)
**Target branch:** `feat/engine-trust-engine`
**Goal:** Add RFC 9421 HTTP Message Signature verification to the Go edge verifier; add signing helpers to both Go and Node clients; implement three-way outcome model.

---

## Context

The current edge verifier (`cmd/edge-verifier/main.go`) only does fingerprint allow/deny. Plan 3 adds cryptographic request authentication using Ed25519 HTTP Message Signatures (RFC 9421). Every agent request will be signed; the verifier checks the signature against a known registry of agent keys.

**Three-way outcome model:**
- **Signed + verified** → trust engine decides allow/deny
- **Unsigned** → policy passthrough (permissive) or deny (strict), never trust engine
- **Invalid signature** → 401 or 403, never passthrough

---

## Key Design Decisions

1. **Signature components:** `@method`, `@target-uri`, `@created`, `@expires`, `content-digest` (on body)
2. **`@authority` omitted** — subsumed by `@target-uri`
3. **Key identification:** `keyid` format `vrl:agent:<agent-did>:<key-label>`, `key_hash` = SHA-256 over raw 32-byte Ed25519 public key
4. **Algorithm:** `ed25519` only (no RSA/ECDSA)
5. **Nonces:** 128-bit hex, unique per `(keyid, nonce)` within TTL window (in-memory with TTL expiry)
6. **`created` window:** ±30s clock skew, max 5min age
7. **`external_base_url`:** CLI flag for `@target-uri` base; when set, incoming `Host` header is ignored
8. **Dependencies:** Go stdlib only (`crypto/ed25519`, `crypto/sha256`, `encoding/base64`) — zero new deps
9. **Config:** JSON agent registry file (no DB needed for MVP)

---

## Task List

### 1. `pkg/requestsigin/sign.go` — Signature construction + verification (Go)
- `SignatureInput` struct, `ComputeKeyHash(pub ed25519.PublicKey) string`
- `BuildSignatureBase(params) string` — canonical per RFC 9421 §2.1
- `Sign(params, privateKey) (sigInput, signature string)`
- `Verify(sigBase, sigB64, pub ed25519.PublicKey) error`
- `VerifySignatureInput(header string, getBody func() []byte, pk ed25519.PublicKey) error`
- `ComputeContentDigest(body) string`
- Tests in `pkg/requestsigin/sign_test.go`

### 2. `pkg/requestsigin/nonce.go` — Nonce replay cache
- `NonceCache` struct with `CheckAndConsume(nonce, keyid) bool`, background sweep
- In-memory with TTL expiry
- Tests in `pkg/requestsigin/nonce_test.go`

### 3. `pkg/requestsigin/config.go` — Agent registry config
- `AgentEntry` struct (DID, public key, label, allowed URIs)
- `AgentRegistry` struct with `Lookup(keyid)`, `LoadFromFile(path)`, `SaveToFile(path)`
- Tests in `pkg/requestsigin/config_test.go`

### 4. `cmd/edge-verifier/main.go` — Rewire for three-way outcome
- Add `external_base_url`, `agent-keys-path`, `require-signatures` CLI flags
- Replace current ServeHTTP with three-way logic:
  - Parse `Signature-Input` header → verify → trust engine if valid
  - No header → policy passthrough or deny
  - Invalid → 401/403
- Update tests in `cmd/edge-verifier/main_test.go`

### 5. `client/go/verilink.go` — Add signing to Go client
- Add `SignRequest(ctx, req, privateKey, keyLabel) error` method
- Add `MakeRequest(ctx, method, path, body) (*http.Request, error)` with auto-signing
- Tests in `client/go/verilink_test.go`

### 6. `client/node/index.js` — Add signing to Node client
- Add `signRequest(req, privKey, keyLabel)` function
- Add `makeSignedRequest(method, url, body)` convenience method
- Tests in `client/node/test/signing.test.js`

### 7. `docs/spec/rfc9421-request-auth.md` — Implementation spec
- Document the canonicalization rules, nonce lifecycle, config format, key hash algorithm

### 8. End-to-end test
- Integration test: sign request → edge verifier → backend receives it
- Test unsigned request → passthrough (when policy allows)
- Test invalid signature → 401

---

## Verification

- `go test ./pkg/requestsigin/... -v` — unit tests pass
- `go test ./cmd/edge-verifier/... -v` — integration tests pass
- `go test ./client/go/... -v` — client tests pass
- `npm test` (in `client/node/`) — Node signing tests pass
- Manual test: sign request with Go client, hit edge verifier, verify backend receives it
