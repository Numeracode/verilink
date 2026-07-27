# Plan 4 — Attestation Ingest End-to-End

**Depends on:** Plans 1-3 (merged to main)
**Target branch:** `feat/attestation-ingest`
**Goal:** Complete the attestation ingest pipeline from JWS submission through verification, schema validation, dedup, and storage.

---

## Context

The current attestation flow (Plan 2) accepts a pre-verified payload from the caller. Plan 4 replaces this with the full end-to-end pipeline: the control plane receives a raw JWS token, pre-parses it for `iss`/`kid`/`iat`, resolves candidate keys, calls trust-engine gRPC for synchronous verification, validates the schema, deduplicates on `token_digest`, lazily creates the subject principal, and stores the attestation transactionally.

**Key spec requirements (§4.5):**
1. Pre-parse unverified JWS for `iss`, `kid`, `iat`
2. Resolve candidate keys from `principal_keys` valid at `iat`, not revoked
3. `kid` present → select that key directly; absent → try all candidate keys (legacy)
4. Unknown `iss` → reject 4xx and audit
5. Synchronous verification via `trust-engine.VerifyAttestation`
6. Synchronous schema validation against versioned facts schema
7. Dedup on `token_digest` (sha256 of JWS)
8. Lazy subject principal creation
9. No attestation sync event (score recomputation emits edge-visible events)

---

## Task List

### 1. `control-plane/src/domains/attestation/jws.ts` — JWS pre-parser
- `preParseJWS(token: string): { header, payload }` — decode base64url header+payload without verifying
- Extract `iss`, `kid`, `iat` from decoded payload
- Reject malformed JWS (not 3 parts, invalid base64, not JSON)
- Tests in `jws.test.ts`

### 2. `control-plane/src/domains/attestation/schemaValidator.ts` — Attestation schema validation
- `validateSchema(type, schemaVersion, facts): void`
- Support `behavioral@0` (legacy allowlisted) and `behavioral@1` (native)
- Unknown type or version → 4xx
- Tests in `schemaValidator.test.ts`

### 3. `control-plane/src/domains/principal/principalRepository.ts` — Add key lookup at timestamp
- `getActiveKeysAt(principalId: string, iat: Date): Promise<PrincipalKey[]>` — returns keys valid at `iat`, not revoked, where `kid` matches if provided
- `getKeyByKid(principalId, keyId): Promise<PrincipalKey | null>`
- `getIssuer(principalId): Promise<Issuer | null>`
- Tests

### 4. `control-plane/src/grpc/trustEngineClient.ts` — gRPC client for trust-engine
- `createTrustEngineClient(address: string): TrustEngineClient`
- `verifyAttestation(jwsToken, candidateKeys): Promise<VerifyResult>`
- Wrap the gRPC call with proper error handling and timeouts
- Tests with mock gRPC server

### 5. `control-plane/src/domains/attestation/attestationService.ts` — Rewrite submitAttestation
- Accept raw JWS token only (no pre-verified payload)
- Flow:
  1. Pre-parse JWS → extract `iss`, `kid`, `iat`
  2. Look up issuer principal + issuer record → reject if unknown or not an issuer
  3. Resolve candidate keys (valid at `iat`, not revoked; `kid` if present)
  4. Call `trustEngineClient.verifyAttestation()` → get `VerifyResult`
  5. If invalid → reject 4xx
  6. Validate schema (`type@schemaVersion`)
  7. Validate `trust_delta` range and sign (negative for `negative_incident`)
  8. Validate `observation_id` pairing if present (matching type + trust_delta)
  9. Dedup on `token_digest`
  10. Lazy subject creation
  11. Store attestation transactionally
  12. Return stored attestation
- No attestation sync event written

### 6. `control-plane/src/routes/attestations.ts` — Update route
- Accept `{ token: string }` only (remove `verified` field)
- Call `attestationService.submitAttestation({ jwsToken: token })`
- Return 201 on success, 409 on duplicate, 4xx on validation errors

### 7. End-to-end test
- Integration test: create issuer principal + key, sign attestation with Go client, submit to control plane, verify stored
- Test duplicate rejection
- Test invalid signature rejection
- Test unknown issuer rejection
- Test schema validation rejection

---

## Verification

- `npm test` in `control-plane/` — all tests pass
- `go test ./...` — all Go tests still pass
- Manual: sign attestation with Go client → POST to control plane → verify stored in DB