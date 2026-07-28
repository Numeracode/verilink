# Handover Note — VeriLink Productization

> **Updated:** 2026-07-28  
> **Repo HEAD:** `main` @ `b2f7e2d` (PR #9 merged)  
> **Status:** Plans 1–4 (productization core) + Plan 5 (integration harness/CI) are on `main`  
> **Next session:** Start productization sequencing **step 10** (network score computation), unless the user picks a different track

---

## Where We Are

VeriLink is past the “toolkit only” MVP. The monorepo now has:

| Surface | Location | Notes |
|---------|----------|--------|
| Trust engine (gRPC) | `cmd/trust-engine`, `internal/trustengine` | `RunVeriRank`, `VerifyAttestation`, `GetFingerprint` |
| Edge verifier | `cmd/edge-verifier`, `internal/edgeverifier` | RFC 9421 three-way outcomes + trust annotations |
| Control plane (TS) | `control-plane/` | Express + Postgres; attestation ingest E2E |
| Clients | `client/go`, `client/node` | Signing helpers present |
| Proto | `proto/verilink/trust/v1/trust.proto` → `pkg/trustpb` | Buf pipeline in CI |

**Canonical design:** `docs/superpowers/specs/2026-07-25-verilink-productization-design.md`  
**Shared memory:** `/srv/storage/shared/memory/verilink-productization-arc.md` (and index in `MEMORY.md`)

---

## Plan Coverage Audit (2026-07-28)

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

## What’s Next (productization §13)

Highest-value next implementation tracks (not yet done):

1. **Network score computation** (step 10) — global VeriRank → `network_scores` / history + `sync_events`  
2. **Sync event log + edge sync** (step 11) — snapshot + SSE, edge cache refresh  
3. **Go edge hardening** (step 12) — versioned sync client, WAL/snapshots, drop counters  
4. **Dashboard** (step 13) — provider / agent-builder / admin  
5. **Bootstrap registry + seed** (step 14)  
6. **Deploy artifacts** (step 15) — Docker/Helm/releases  
7. **Client publish** (step 16) — npm `@verilink/node`  
8. **Whimsy + Codero reference integrations** (steps 17–18) — privacy counsel gates apply

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
cd control-plane && npm run test:integration

# Edge / trust-engine local
go run ./cmd/edge-verifier
go run ./cmd/trust-engine
```
