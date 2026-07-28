# VeriLink Repo Policy

Global policy authority: `/srv/storage/AGENTS.md`.
If any rule conflicts, global policy wins.

## Session Start — Clean Workspace Gate — MANDATORY

**Before starting any new work, run these checks. If any fail, resolve first — do not start new work.**

```bash
git status --short          # must be empty — no uncommitted changes
git branch                  # must show only: * main (no other local branches)
git worktree list           # must show only the main worktree
git log origin/main..HEAD   # must be empty — main not ahead of remote
git stash list              # must be empty
```

Resolution rules:
- Uncommitted changes → commit on a branch, or stash with a descriptive message
- Local branches → raise a PR, merge, or delete (confirm with user before deleting)
- Active worktrees → finish, merge, or remove them
- Main ahead of origin → push before starting new work

## Canonical Path

`/srv/storage/repo/VeriLink/`

## Service Ownership

VeriLink owns the Trust Protocol for the Agentic Economy: Non-Human Identity (NHI) verification, deterministic fingerprinting, and transitive trust propagation.

## Stack

- Languages: Go (core + edge + trust-engine) and TypeScript (control plane)
- Core Go: `pkg/fingerprint`, `pkg/attestation`, `pkg/trust`, `pkg/requestsigin`, `pkg/trustpb`
- Packages: `internal/trustengine`, `internal/edgeverifier`, `internal/testutil`
- Services:
  - `cmd/edge-verifier`: RFC 9421 reverse proxy (Port 8080)
  - `cmd/trust-engine`: gRPC trust APIs (default gRPC listen; see flags)
  - `cmd/attestation-service`: Legacy/demo behavioral HTTP API (Port 8082)
  - `control-plane/`: Express + Postgres control plane (attestations, principals, tenancy)
- Database: Postgres for control plane (`verilink_test` for integration); Redis/score sync still productization backlog
- Security: Ed25519, JWS attestations, RFC 9421 HTTP Message Signatures

## Branch And PR Policy

- Branch naming: `feat/<description>` or `fix/<description>`
- No direct commits to `main`.
- PR required before merge.

## Review Gate Policy

- **Pre-commit:** CodeRabbit CLI is the primary AI gate (shared rate limit: 12/hr across all repos).
- **PR review:** CodeRabbit PR review required before merge:
  - request `@coderabbitai review`
  - address findings before merging

## Clean Gate Policy

**Full gate contract:** `docs/gate-contract.md`

### Pre-commit (local, blocking)
- `gitleaks detect --staged` — secrets scan
- `go vet ./...` — static analysis
- `goimports -l .` — import ordering

### Pre-push (local, blocking)
- `go test ./...` — full test suite
- `go build ./...` — build verification
- `govulncheck ./...` — vulnerability scan

### CI (GitHub Actions, blocking)
- `golangci-lint run --timeout 5m` — comprehensive linting (PR-scoped via `--new-from-rev`)
- `go test -race -count=1 ./...` — race condition detection
- `go build ./...` — build verification
- Proto job: `buf lint` + generate + `goimports` + `git diff --exit-code` on `pkg/trustpb`
- `gitleaks detect --source .` — secrets scan
- `govulncheck ./...` — vulnerability scan
- `gocyclo -over 25` — cyclomatic complexity (PR-scoped)
- `go test -tags=integration -count=1 ./...` — Go integration
- Control-plane integration: Postgres service + `npm run test:integration`

### Severity levels
- **critical/high:** Block merge
- **medium/low:** Recorded, informational

### Waivers
- Add to `.gate-waivers.json` with reason, author, expiry
- 30-day auto-expiry, renewal requires re-review

## Local Dev Commands

```bash
# Run all tests
go test ./...

# Run tests with race detector
go test -race ./...

# Build all binaries
go build ./...

# Lint
golangci-lint run --timeout 5m

# Vulnerability check
govulncheck ./...

# Proto lint
buf lint

# Start Edge Verifier
go run cmd/edge-verifier/main.go

# Start Attestation Service
go run cmd/attestation-service/main.go
```
