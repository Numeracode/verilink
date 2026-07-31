# Handover Note — VeriLink Productization

> **Updated:** 2026-07-31  
> **Repo HEAD:** `main` @ Plan 8 PR C (#21) merged  
> **Status:** Plans 1–8 done (A+B+C).  
> **Next session:** Dashboard (design §13 step 13)

---

## Where We Are

VeriLink is past the “toolkit only” MVP. The monorepo now has:

| Surface | Location | Notes |
|---------|----------|--------|
| Trust engine (gRPC) | `cmd/trust-engine`, `internal/trustengine` | `RunVeriRank`, `VerifyAttestation`, `GetFingerprint` |
| Edge verifier | `cmd/edge-verifier`, `internal/edgeverifier` | RFC 9421 + SSE sync + decision WAL/flush |
| Control plane (TS) | `control-plane/` | Express + Postgres; ingest E2E; score writer + recompute scheduler (Plan 6) |
| Clients | `client/go`, `client/node` | Signing helpers present |
| Proto | `proto/verilink/trust/v1/trust.proto` → `pkg/trustpb` | Buf pipeline in CI |

**Canonical design:** `docs/superpowers/specs/2026-07-25-verilink-productization-design.md`  
**Shared memory:** `/srv/storage/shared/memory/verilink-productization-arc.md` (and index in `MEMORY.md`)

---

## Plan Coverage Audit (2026-07-29)

### Plan 1 — Engine + trust-engine gRPC — DONE
- PRs: #1, folded into #4  
- Plan doc: `docs/superpowers/plans/2026-07-25-verilink-1-engine-trust-engine.md` (detailed; from PR #1)  
- Spec: `docs/superpowers/specs/2026-07-25-verilink-productization-design.md`  
- Delivered: `RunVeriRank`, weights/roots/blacklist/`score_reason`, proto + `cmd/trust-engine`, property/contract tests, VR-002 baseline benchmark

### Plan 2 — Control-plane foundation — DONE
- PR: #4  
- Plan doc: `docs/superpowers/plans/2026-07-27-verilink-2-control-plane-foundation.md` (detailed)  
- Delivered: Express app, auth (OIDC + API keys), migrations `001`–`008`, principals/attestations/sync/tenancy/policy/audit domains

### Plan 3 — Request-auth (RFC 9421) — DONE
- PR: #5  
- Plan doc: `docs/superpowers/plans/2026-07-27-verilink-3-request-auth-protocol.md` (short checklist; intentional)  
- Delivered: `pkg/requestsigin`, edge three-way outcomes, Go + Node signing, `docs/spec/rfc9421-request-auth.md`  
- Known hardening follow-up: require or opt-in `external-base-url` so `@target-uri` is not client-controlled when unset

### Plan 4 — Attestation ingest E2E — DONE
- PR: #6  
- Plan doc: `docs/superpowers/plans/2026-07-27-verilink-4-attestation-ingest.md` (short checklist; intentional)  
- Delivered: JWS pre-parse, schema validation, key lookup at `iat`, dedup, lazy subject, route `{ token }` only  
- **Intentional v1 deviation:** `control-plane/src/grpc/trustEngineClient.ts` verifies in-process with Node `crypto` (mirrors gRPC contract; does not dial Go trust-engine yet)

### Plan 5 — Integration test suite + CI — DONE
- PRs: #7 (suite/harness), #8 (CI wiring), #9 (negative-path + tenant-binding coverage)  
- Docs: `docs/superpowers/plans/2026-07-28-integration-test-suite.md`, `docs/superpowers/specs/2026-07-28-integration-test-suite-design.md`  
- CI jobs: Gate, Proto, **Go integration**, **Control plane integration** (Postgres service)

User judgment: **Plans 1–4 are covered well enough to move on.** Remaining work is productization sequencing **after** step 9 (see design §13).

---

## Plan 6 — Network score computation — DONE

- Plan doc: `docs/superpowers/plans/2026-07-28-network-score-computation.md`
- Design: §4.5 + §13 step 10
- **PR A (merged #12):** migrations `009`–`012`, loader, writer, RunVeriRank gRPC client + units
- **PR B (merged #13):** `RecomputeScheduler`, ingest `markDirty`, mandatory CI trust-engine + score-recompute integration

---

## Plan 7 — SSE edge sync — DONE

- Plan doc: `docs/superpowers/plans/2026-07-29-plan-7-sse-edge-sync.md` (merged PR #14)
- Design: §4.5 steps 3–5 + §13 step 11
- **PR A (#15):** long-lived SSE + heartbeat + backlog `429` + snapshot compression + graceful `shutdown` — **merged**
- **PR B (#16):** integration suite + `sync_cursors` + `/v1/admin/sync/lag` + tenant-scoped lag fixes — **merged**

---

## Plan 8 — Go edge hardening — DONE

- Plan doc: `docs/superpowers/plans/2026-07-30-plan-8-go-edge-hardening.md` (merged PR #17)
- Design: §4.5 + §4.7 + §13 step 12
- **PR A (#18):** `internal/edgeverifier` snapshot + apply + SSE/cpclient + disk + proxy read-path — **merged**
- **PR B (#20):** decision WAL + flush interface + metrics — **merged**
- **PR C (#21):** control-plane `POST /v1/decisions/batch` + HTTP flush transport — **merged**
- **RFC 9421 already done** (Plan 3) — Plan 8 replaces mock trust/key sources with synced state

### What’s after Plan 8 (§13)

1. **Dashboard** (step 13)  
2. **Bootstrap registry + seed** (step 14)  
3. **Deploy / clients / reference integrations** (steps 15–18)

Also useful: refresh stale remote branches (`origin/feat/engine-trust-engine`, `origin/feat/attestation-ingest`, `origin/docs/verilink-productization-design`) if they are abandoned.

---

## Key Files

| File | Purpose |
|------|---------|
| `docs/superpowers/specs/2026-07-25-verilink-productization-design.md` | Product design + sequencing |
| `docs/superpowers/plans/2026-07-25-verilink-1-engine-trust-engine.md` | Plan 1 (detailed) |
| `docs/superpowers/plans/2026-07-27-verilink-2-control-plane-foundation.md` | Plan 2 (detailed) |
| `docs/superpowers/plans/2026-07-27-verilink-3-request-auth-protocol.md` | Plan 3 |
| `docs/superpowers/plans/2026-07-27-verilink-4-attestation-ingest.md` | Plan 4 |
| `docs/superpowers/plans/2026-07-28-network-score-computation.md` | Plan 6 |
| `docs/superpowers/plans/2026-07-29-plan-7-sse-edge-sync.md` | Plan 7 |
| `docs/superpowers/plans/2026-07-30-plan-8-go-edge-hardening.md` | Plan 8 |
| `docs/gate-contract.md` | Local + CI gate contract |
| `internal/testutil/` | Go service harnesses |
| `control-plane/src/testutil/` | TS DB/app harnesses |

---

## Quick Reference

```bash
# Go unit
go test ./...

# Go integration (build-tagged)
go test -tags=integration -count=1 ./...

# Control plane
cd control-plane && npm run test:unit
# Needs local Postgres verilink_test (default URL uses 127.0.0.1:15432)
# Score recompute integration also needs trust-engine running in another shell:
#   go run ./cmd/trust-engine -grpc-port 9091 -http-port 8086
cd control-plane && TRUST_ENGINE_ADDR=127.0.0.1:9091 npm run test:integration

# Edge / trust-engine local
go run ./cmd/edge-verifier
go run ./cmd/trust-engine
```
