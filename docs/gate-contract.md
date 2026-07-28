# Gate Contract

**Status:** active
**Applies to:** VeriLink Go monorepo
**Enforced via:** pre-commit hooks, CI (GitHub Actions), pre-push gate

This contract defines the clean gate policy for VeriLink. All PRs must pass
the gates defined here before merge. The gate is deterministic — same code +
same gate version = same verdict.

---

## 1. Gate stages

### 1.1 `pre-commit` (local, blocking)

Runs on every `git commit`. Must pass before commit is created.

| Order | Check | Tool | Timeout | Severity |
|-------|-------|------|---------|----------|
| 1 | Secrets scan | `gitleaks detect --staged` | 30s | critical |
| 2 | Go vet | `go vet ./...` | 60s | high |
| 3 | Import ordering | `goimports -l .` | 10s | medium |

**Bypass:** `git commit --no-verify` records a finding; does NOT block locally
but will block CI.

### 1.2 `pre-push` (local, blocking)

Runs before `git push`. Catches issues early without waiting for CI.

| Order | Check | Tool | Timeout | Severity |
|-------|-------|------|---------|----------|
| 1 | Full test suite | `go test ./...` | 120s | high |
| 2 | Build all binaries | `go build ./...` | 60s | high |
| 3 | Vulnerability scan | `govulncheck ./...` | 60s | medium |

### 1.3 `ci` (GitHub Actions, blocking)

Runs on every PR push and main merge. All checks must pass for merge.

| Order | Check | Command | Timeout | Severity |
|-------|-------|---------|---------|----------|
| 1 | Lint | `golangci-lint run --timeout 5m` | 300s | high |
| 2 | Test (race) | `go test -race -count=1 ./...` | 300s | critical |
| 3 | Build | `go build ./...` | 120s | high |
| 4 | Proto check | `buf lint && buf generate --diff` | 60s | high |
| 5 | Secrets | `gitleaks detect --source . --verbose` | 60s | critical |
| 6 | Vulnerability | `govulncheck ./...` | 120s | medium |
| 7 | cyclomatic complexity | `gocyclo -over 25 .` | 60s | medium |
| 8 | Go integration | `go test -tags=integration -count=1 ./...` | 600s | critical |
| 9 | Control plane integration | Postgres service + `npm run test:integration` in `control-plane/` | 900s | critical |

Control-plane integration CI sets `DATABASE_URL` to a dedicated `verilink_test`
database on `127.0.0.1` (see `control-plane/src/testutil/testDb.ts` safety guard).

### 1.4 `post-merge` (informational)

Runs after merge to main. Findings are recorded but do not block.

| Check | Tool | Purpose |
|-------|------|---------|
| Coverage delta | `go test -coverprofile` | Track coverage regression |
| Dependency audit | `govulncheck` | Catch newly disclosed vulns |

---

## 2. Severity levels

| Level | Blocks merge? | Example |
|-------|---------------|---------|
| **critical** | Yes | Race condition, secret leak, test failure |
| **high** | Yes | Build failure, vet error, lint error |
| **medium** | No (recorded) | Complexity warning, vuln advisory, style |
| **low** | No (recorded) | Documentation gap |

**Block threshold:** `high` and above block merge. `medium` and below are
informational — they appear in PR review but do not prevent merge.

---

## 3. Findings format

All checks emit findings in a consistent format:

```json
{
  "check": "go-vet",
  "severity": "high",
  "file": "control-plane/main.go",
  "line": 42,
  "message": "unused variable: foo",
  "hash": "stable-sha256-of-finding"
}
```

Findings with the same `hash` across runs are deduplicated. Findings can be
waived via the waiver process (see §5).

---

## 4. Waiver process

Findings can be waived by a maintainer with `admin` role:

1. **Manual waiver:** Add to `.gate-waivers.json`:
   ```json
   [
     {
       "finding_hash": "abc123...",
       "reason": "False positive — gocyclo counts test helper branches",
       "waived_by": "sanjay",
       "expires": "2026-08-27"
     }
   ]
   ```

2. **Expiry:** Waivers auto-expire after 30 days. Renewals require re-review.

3. **Audit:** All waivers are logged and visible in PR comments.

---

## 5. Local development

### Quick check (pre-commit only)

```bash
# Install hooks
git config core.hooksPath .githooks

# Or run manually
.githooks/pre-commit
```

### Full gate check

```bash
# Run all pre-push checks
.githooks/pre-push

# Or individual checks
go vet ./...
go test ./...
go build ./...
golangci-lint run
govulncheck ./...
```

### CI simulation

```bash
# Simulate CI locally
golangci-lint run --timeout 5m
go test -race -count=1 ./...
go build ./...
buf lint
gitleaks detect --source . --verbose
govulncheck ./...
gocyclo -over 25 .
```

---

## 6. Configuration files

| File | Purpose |
|------|---------|
| `.golangci.yml` | golangci-lint configuration |
| `.githooks/pre-commit` | Pre-commit hook script |
| `.githooks/pre-push` | Pre-push hook script |
| `.gate-waivers.json` | Active waivers |
| `buf.yaml` | Proto lint/breaking change config |

---

## 7. Enforcement rules

1. **No direct pushes to `main`** — all changes via PR with passing CI.
2. **No force-pushes** — rewrite history is prohibited on `main`.
3. **Branch protection** — require CI pass + 1 approval for merge.
4. **Dependabot** — auto-bumps allowed; must pass CI before merge.
5. **Stale PRs** — PRs older than 14 days without activity get a warning;
   30 days without activity get closed.

---

## 8. Exceptions

- **Emergency hotfixes:** A maintainer can override the gate with a manual
  merge + post-hoc review. Must include a follow-up PR with full gate pass.
- **Proto changes:** Must pass `buf generate --diff` to ensure generated code
  is committed. Stale generated code is a blocking finding.
