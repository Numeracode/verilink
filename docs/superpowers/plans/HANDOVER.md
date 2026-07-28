# Handover Note — Integration Test Suite (Plan 5)

> **Created:** 2026-07-28
> **Status:** Implementation plan written, ready to execute
> **Next session:** Start with Task 1

---

## What Was Done

### Completed Work
- Synced VeriLink to `origin/main` (was 18 commits behind)
- Added clean gate policy (pre-commit, pre-push hooks, CI workflow, golangci-lint, gitleaks)
- Updated dependencies (grpc v1.82.1, net v0.57.0, text v0.40.0, Go 1.25.12) — 0 vulnerabilities
- Closed Dependabot PRs #2 and #3
- Wrote design spec: `docs/superpowers/specs/2026-07-28-integration-test-suite-design.md`
- Iterated spec through 3 rounds of feedback
- Wrote implementation plan: `docs/superpowers/plans/2026-07-28-integration-test-suite.md`

### Not Yet Done
- Implementation plan NOT committed to git
- No code written yet

---

## How to Continue

### Step 1: Commit the plan
```bash
cd /srv/storage/repo/VeriLink
git add docs/superpowers/plans/2026-07-28-integration-test-suite.md
git commit -m "docs: add Plan 5 integration test suite implementation plan"
```

### Step 2: Read the plan
```bash
cat docs/superpowers/plans/2026-07-28-integration-test-suite.md
```

### Step 3: Execute tasks in order
Start with Task 1: Extract trust-engine startup into `internal/trustengine/server.go`

The plan has 13 tasks total — follow them sequentially, committing after each.

---

## Key Files

| File | Purpose |
|------|---------|
| `docs/superpowers/plans/2026-07-28-integration-test-suite.md` | **THE PLAN** — full task list |
| `docs/superpowers/specs/2026-07-28-integration-test-suite-design.md` | Design spec (context) |
| `cmd/trust-engine/main.go` | Source for Task 1 extraction |
| `cmd/edge-verifier/main.go` | Source for Task 2 extraction |
| `pkg/trustpb/trust.proto` | gRPC contract |
| `control-plane/src/domains/attestation/attestationService.ts` | HTTP status codes |
| `control-plane/src/middleware/auth.ts` | Auth middleware + scopes |
| `pkg/trust/integration_test.go` | Existing test (no build constraint) |

---

## Architecture Context

### Edge Verifier
- Uses injected `verifier.TrustStore`, annotates with `X-Verilink-Auth-Status`/`X-Verilink-Trust-Score`
- No threshold-based deny — trust score is informational only
- Auth statuses: `signed-verified`, `unsigned-passthrough`, `unsigned-rejected`, `invalid-signature`, `replay-detected`

### Trust Engine
- gRPC service with: `RunVeriRank`, `VerifyAttestation`, `GetFingerprint`
- No `GetTrustScore` RPC — trust scoring is in edge-verifier only

### Control Plane
- Postgres (not SQLite) via `pg` + `DATABASE_URL`
- Auth middleware + `requireScope(...)` on attestation routes
- HTTP status: 400 (BAD_REQUEST), 409 (CONFLICT), 422 (UNPROCESSABLE), 401 (UNAUTHORIZED), 403 (FORBIDDEN)
- Tenant isolation is filter-based (empty result), not reject-based

---

## Quick Reference

### Run Go unit tests
```bash
go test ./...
```

### Run Go integration tests
```bash
go test -tags=integration ./cmd/... ./pkg/...
```

### Run control-plane tests
```bash
cd control-plane && npm run test:unit
cd control-plane && npm run test:integration
```

### Full verification
```bash
go test ./... && go test -tags=integration ./... && cd control-plane && npm run test:unit && npm run test:integration
```
