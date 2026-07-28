# Plan 5 — Integration Test Suite (In-process)

**Depends on:** Plans 1-4 (merged to main)
**Target branch:** `feat/integration-tests`
**Goal:** End-to-end integration tests covering service-to-service boundaries, attestation flow, edge verifier decisions, and multi-tenant isolation.

---

## Context

Plans 1-4 implemented the core VeriLink services:
- Trust Engine (gRPC, Go)
- Control Plane (HTTP, TypeScript/Postgres)
- Edge Verifier (HTTP proxy, Go)
- Attestation Service (HTTP, Go)

Test coverage varies: `pkg/*` packages are well-tested (76-91%), but `cmd/*` services have lower coverage (22-59%). This plan adds integration tests that exercise service boundaries.

**Note on infrastructure:** Control-plane integration tests require a local Postgres instance. Set `DATABASE_URL=postgres://user:pass@localhost:5432/verilink_test` before running. No Docker is required; a bare Postgres is sufficient.

---

## Key Design Decisions

1. **In-process test harness** — Start Go services in-process using `httptest.Server` and gRPC test servers; no Docker required
2. **Separate Go and TypeScript harnesses** — `internal/testutil/` for Go, `control-plane/src/testutil/` for TypeScript
3. **Real Postgres for control-plane** — Control-plane uses `pg` + `DATABASE_URL`; integration tests require a local Postgres instance
4. **Private test utilities** — `internal/testutil/` not `pkg/testutil/`; keep test harnesses off the public API surface
5. **Extract startup code** — Factor reusable startup logic out of `cmd/*` mains into testable packages
6. **Tag-gated execution** — Use `-tags=integration` for Go integration tests to separate from unit tests
7. **Align to current service contracts** — Test what actually exists, not aspirational APIs

---

## Actual Service Contracts (verified)

### Edge Verifier (`cmd/edge-verifier/main.go`)

- Accepts injected `verifier.TrustStore` interface (not a trust-engine address)
- Three-way outcome model:
  - **Signed + valid signature** → `X-Verilink-Auth-Status: signed-verified`, proxy to backend, set `X-Verilink-Trust-Score` from TrustStore
  - **Unsigned** → if `require-signatures=true`: `401` + `X-Verilink-Auth-Status: unsigned-rejected`; otherwise: `X-Verilink-Auth-Status: unsigned-passthrough` + proxy
  - **Invalid signature** → `401` + `X-Verilink-Auth-Status: invalid-signature`
- **No threshold-based deny** — The edge-verifier does NOT deny based on trust score; it only annotates. Deny logic is the caller's responsibility.

### Trust Engine (`proto/verilink/trust/v1/trust.proto`)

- `RunVeriRank(stream RunChunk) returns (ScoreTable)` — Client-streamed computation; first chunk MUST be `RunHeader`, subsequent chunks are attestations/principals/roots
- `VerifyAttestation(VerifyRequest) returns (VerifyResult)` — Synchronous JWS signature verification
- `GetFingerprint(FingerprintRequest) returns (Fingerprint)` — Deterministic fingerprint generation
- **No `GetTrustScore` RPC** — The engine is a compute/verify service, not a persisted score store. Scores are computed via `RunVeriRank` and returned in `ScoreTable`.

### Control Plane (`control-plane/src/domains/attestation/attestationService.ts`)

- Current HTTP status mapping:
  - `CODES.BAD_REQUEST` (400) — malformed JWS, unknown issuer, unknown key, schema validation failure, trust_delta out of range, etc.
  - `CODES.CONFLICT` (409) — duplicate attestation (same `token_digest`)
  - `CODES.UNPROCESSABLE` (422) — schema validation with expired schema
  - `CODES.NOT_FOUND` (404) — attestation not found

---

## File Layout

```
internal/
├── trustengine/
│   └── server.go           # Extracted from cmd/trust-engine (NewServer, Run)
├── edgeverifier/
│   └── proxy.go            # Extracted from cmd/edge-verifier (NewEdgeVerifierProxy, ServeHTTP)
└── testutil/
    ├── trust_engine.go     # StartTrustEngine(), gRPC test server
    ├── edge_verifier.go    # StartEdgeVerifier(), real proxy with mock TrustStore
    ├── seed_data.go        # SeedTestData(), test issuers/keys
    └── assertions.go       # Helpful assertion helpers

control-plane/src/testutil/
├── appHarness.ts           # StartControlPlane(), real HTTP server
├── seedData.ts             # SeedTestData(), test issuers/keys, API keys, auth headers
└── testDb.ts               # Database setup/teardown helpers

control-plane/src/__tests__/integration/
├── attestation-flow.test.ts    # Full attestation lifecycle
└── tenant-isolation.test.ts    # Multi-tenant visibility

cmd/edge-verifier/
└── main_integration_test.go    # Edge verifier + trust store integration

cmd/trust-engine/
└── server_integration_test.go  # Trust engine gRPC contract tests
```

---

## Task List

### 1. Extract startup code from `cmd/*` mains

The trust-engine and edge-verifier have startup logic coupled to `main()`. Extract reusable functions into new internal packages:

**New package `internal/trustengine/server.go`:**
- Move `NewServer(cfg Config) *grpc.Server` from `cmd/trust-engine/server.go`
- Move `Run(s *grpc.Server, addr string) error` from `cmd/trust-engine/main.go`
- `cmd/trust-engine/main.go` imports and calls `internal/trustengine`

**New package `internal/edgeverifier/proxy.go`:**
- Move `NewEdgeVerifierProxy(target string, ts verifier.TrustStore, ...) *EdgeVerifierProxy` from `cmd/edge-verifier/main.go`
- Move `ServeHTTP` and helper methods
- `cmd/edge-verifier/main.go` imports and calls `internal/edgeverifier`

This allows `internal/testutil/` to start services by importing `internal/trustengine` and `internal/edgeverifier`, not `cmd/*`.

### 2. `internal/trustengine/server.go`

```go
func NewServer(cfg Config) *grpc.Server
func Run(s *grpc.Server, addr string) error
```

- Extracted from `cmd/trust-engine/server.go` and `cmd/trust-engine/main.go`
- `cmd/trust-engine/main.go` updated to call `internal/trustengine.Run()`

### 3. `internal/edgeverifier/proxy.go`

```go
func NewEdgeVerifierProxy(target string, ts verifier.TrustStore, ...) *EdgeVerifierProxy
func (p *EdgeVerifierProxy) ServeHTTP(w http.ResponseWriter, r *http.Request)
```

- Extracted from `cmd/edge-verifier/main.go`
- `cmd/edge-verifier/main.go` updated to call `internal/edgeverifier.NewEdgeVerifierProxy()`

### 4. `internal/testutil/trust_engine.go`

```go
type TrustEngineHarness struct {
    Client  trustpb.TrustEngineClient
    Stop    func()
}

func StartTrustEngine(t *testing.T) *TrustEngineHarness
```

- Start gRPC server on random port
- Return client + cleanup function
- Seed test data (roots of trust, attestations)

### 3. `internal/testutil/edge_verifier.go`

```go
type EdgeVerifierHarness struct {
    URL   string
    Stop  func()
}

func StartEdgeVerifier(t *testing.T, target string, ts verifier.TrustStore) *EdgeVerifierHarness
```

- Start HTTP reverse proxy on random port
- Inject mock TrustStore (not trust-engine address)
- Return URL + cleanup function

### 4. `internal/testutil/seed_data.go`

```go
func SeedTestData(t *testing.T, client trustpb.TrustEngineClient)
```

- Create test issuer principal (DID + Ed25519 key)
- Create test attestation (signed JWS)
- Return principals and attestations for RunVeriRank input

### 5. `internal/testutil/assertions.go`

```go
func AssertSignedVerified(t *testing.T, resp *http.Response)
func AssertUnsignedPassthrough(t *testing.T, resp *http.Response)
func AssertUnsignedRejected(t *testing.T, resp *http.Response)
func AssertInvalidSignature(t *testing.T, resp *http.Response)
func AssertTrustScoreHeader(t *testing.T, resp *http.Response, expected int)
func AssertScoreTable(t *testing.T, table *trustpb.ScoreRow, principalID string, expectedScore int32)
```

### 8. `control-plane/src/testutil/testDb.ts`

```typescript
export async function setupTestDb(): Promise<pg.Pool>
export async function teardownTestDb(pool: pg.Pool): Promise<void>
```

- Connect to test Postgres (via `DATABASE_URL` env)
- Run migrations
- Clean tables between tests

### 9. `control-plane/src/testutil/seedData.ts`

```typescript
export async function seedIssuer(pool: pg.Pool, tenantId: string): Promise<{ did: string; privateKey: ed25519.EdPrivateKey }>
export async function seedSubject(pool: pg.Pool, tenantId: string): Promise<{ id: string }>
export async function seedAttestation(pool: pg.Pool, issuer: Issuer, subject: Subject): Promise<string>
export async function seedApiKey(pool: pg.Pool, tenantId: string, scopes: string[]): Promise<string>
export function authHeaders(apiKey: string): Record<string, string>
```

- Create test issuer principal with `owner_tenant_id = tenantId`
- Create test subject principal with `owner_tenant_id = tenantId`
- Sign test attestation JWS
- Seed API key with given tenant + scopes
- Return auth headers for requests

**Critical:** All principals (issuer and subject) MUST be created with the correct `owner_tenant_id` for tenant isolation tests. The visibility filter in `attestationRepository.ts` joins on `principals.owner_tenant_id`, so principals without the correct tenant binding will not appear in filtered queries.

### 10. `control-plane/src/testutil/appHarness.ts`

```typescript
export async function startControlPlane(pool: pg.Pool, trustEngineAddr: string): Promise<{ url: string; stop: () => Promise<void> }>
```

- Start Express app on random port
- Wire to real Postgres + trust-engine gRPC
- Return URL + cleanup function

### 11. `control-plane/src/__tests__/integration/attestation-flow.test.ts`

```typescript
export async function seedApiKey(pool: pg.Pool, tenantId: string, scopes: string[]): Promise<string>
```

- Insert API key record into `api_keys` table with given tenant + scopes
- Return the key string for use in request headers
- Required scopes for attestation routes: `attest:write` (submit), `attest:read` (list)

```typescript
export function authHeaders(apiKey: string): Record<string, string>
```

- Returns `{ 'Authorization': 'Bearer <apiKey>' }` for use in test requests

### 11. `control-plane/src/__tests__/integration/attestation-flow.test.ts`

All requests must include valid auth headers. The harness seeds an API key with `attest:write` + `attest:read` scopes before each test.

**Test 1: Full attestation lifecycle**
- Seed API key with `attest:write` + `attest:read` scopes
- Create issuer via seed data (with `owner_tenant_id`)
- Sign attestation with Go client
- POST to control-plane `/v1/attestations/submit` with auth headers
- Verify 201 response
- GET `/v1/attestations` with auth headers — verify stored

**Test 2: Duplicate rejection**
- Submit same attestation twice with auth headers
- Verify 409 on second submission

**Test 3: Invalid signature rejection**
- Tamper with JWS signature, send with auth headers
- Verify 400 response (BAD_REQUEST)

**Test 4: Unknown issuer rejection**
- Sign with unregistered DID, send with auth headers
- Verify 400 response (BAD_REQUEST)

**Test 5: Schema violation**
- Submit attestation with invalid `vli.type`, send with auth headers
- Verify 400 response (BAD_REQUEST)

**Test 6: Unauthorized request**
- Send request without auth headers
- Verify 401 response

**Test 7: Insufficient scope**
- Seed API key with only `attest:read` (no `attest:write`)
- Send submit request with that key
- Verify 403 response

### 12. `control-plane/src/__tests__/integration/tenant-isolation.test.ts`

All requests include valid auth headers. The harness seeds separate API keys for each tenant.

**Test 8: Cross-tenant visibility**
- Seed API key for Tenant A with `attest:write` + `attest:read`
- Seed API key for Tenant B with `attest:read`
- Seed issuer + subject for Tenant A (with `owner_tenant_id = Tenant A`)
- Create attestation as Tenant A
- Query `/v1/attestations` as Tenant B
- Verify empty result (filter-based isolation, not hard 403)

**Test 9: API-key tenant binding**
- Seed API key scoped to Tenant A
- Seed issuer + subject for Tenant A (with `owner_tenant_id = Tenant A`)
- Use key to create attestation (Tenant A subject)
- Query attestation list — verify only Tenant A's data returned
- No cross-tenant data leaked

### 13. `cmd/edge-verifier/main_integration_test.go`

**Build constraint:** File must start with `//go:build integration` to prevent `go test ./...` from running integration tests.

**Test 12: Edge verifier signed-verified**
- Create mock TrustStore with known fingerprint score
- Seed agent keys in registry
- Sign request with valid signature
- Verify `X-Verilink-Auth-Status: signed-verified`
- Verify `X-Verilink-Trust-Score` header present

**Test 13: Edge verifier unsigned-passthrough**
- Send unsigned request with `require-signatures=false`
- Verify `X-Verilink-Auth-Status: unsigned-passthrough`
- Verify request reaches backend

**Test 14: Edge verifier unsigned-rejected**
- Send unsigned request with `require-signatures=true`
- Verify `401` response
- Verify `X-Verilink-Auth-Status: unsigned-rejected`

**Test 15: Edge verifier invalid-signature**
- Send request with tampered signature
- Verify `401` response
- Verify `X-Verilink-Auth-Status: invalid-signature`

### 14. `cmd/trust-engine/server_integration_test.go`

**Build constraint:** File must start with `//go:build integration` to prevent `go test ./...` from running integration tests.

**Test 16: gRPC VerifyAttestation**
- Submit valid attestation via gRPC
- Verify signature passes

**Test 17: gRPC RunVeriRank**
- Stream principals, attestations, and roots
- Verify ScoreTable returned with correct scores
- Verify blacklisted subjects marked correctly

**Test 18: gRPC GetFingerprint**
- Submit fingerprint request
- Verify deterministic SHA-256 output

---

## Build Constraints

All Go integration test files MUST start with:

```go
//go:build integration
```

This prevents `go test ./...` from running integration tests (which require running services or Postgres). Only `go test -tags=integration ./...` will include them.

Files requiring this constraint:
- `cmd/edge-verifier/main_integration_test.go`
- `cmd/trust-engine/server_integration_test.go`
- Any future `*_integration_test.go` files

**Exception:** `pkg/trust/integration_test.go` already exists WITHOUT a build constraint. This file uses only in-memory components (`attestation.NewService()`, `NewEngine()`, `verifier.NewMockTrustStore()`) — no external dependencies. It is intentionally left in the unit suite and runs with `go test ./...`. Do NOT add a build constraint to it.

---

## Test Execution

**Go unit tests (no integration):**
```bash
go test ./...                                      # Excludes *_integration_test.go (build tag required)
```

**Go integration tests:**
```bash
go test -tags=integration ./cmd/... ./pkg/...      # Service integration tests
go test -tags=integration ./internal/...           # Test helper unit tests
```

**Control-plane unit tests:**
```bash
cd control-plane && npm run test:unit              # Runs node --test --import tsx 'src/**/!(integration)/**/*.test.ts'
```

**Control-plane integration tests:**
```bash
cd control-plane && npm run test:integration       # Runs node --test --import tsx 'src/__tests__/integration/**/*.test.ts'
```

**Required npm scripts in `control-plane/package.json`:**
```json
{
  "scripts": {
    "test": "node --test --import tsx 'src/**/*.test.ts'",
    "test:unit": "node --test --import tsx 'src/**/!(integration)/**/*.test.ts'",
    "test:integration": "node --test --import tsx 'src/__tests__/integration/**/*.test.ts'"
  }
}
```

---

## Requirements

- **Postgres:** Control-plane integration tests require a local Postgres instance
  - Set `DATABASE_URL=postgres://user:pass@localhost:5432/verilink_test`
  - Or use a dedicated test database
- **Go 1.25+:** For gRPC test server support
- **Node 18+:** For `node --test --import tsx`

---

## Success Criteria

- [ ] All 18 integration tests pass
- [ ] `cmd/*` coverage increases to >70%
- [ ] No Docker dependency for test execution
- [ ] Tests run in <30s total
- [ ] CI integration via GitHub Actions workflow
