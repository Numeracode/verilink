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

- Language: Go (Golang)
- Core: `pkg/fingerprint`, `pkg/attestation`, `pkg/trust`
- Services: 
  - `cmd/edge-verifier`: High-performance allow/deny proxy (Port 8080)
  - `cmd/attestation-service`: Behavioral report submission API (Port 8082)
- Database: In-memory (MVP), Redis (Production edge cache)
- Security: Ed25519 (EdDSA) signatures, JWS (JSON Web Signature)

## Branch And PR Policy

- Branch naming: `feat/<description>` or `fix/<description>`
- No direct commits to `main`.
- PR required before merge.

## Review Gate Policy

- **Pre-commit:** CodeRabbit CLI is the primary AI gate (shared rate limit: 12/hr across all repos).
- **PR review:** CodeRabbit PR review required before merge:
  - request `@coderabbitai review`
  - address findings before merging

## Local Dev Commands

```bash
# Run all tests
go test ./...

# Start Edge Verifier
go run cmd/edge-verifier/main.go

# Start Attestation Service
go run cmd/attestation-service/main.go
```
