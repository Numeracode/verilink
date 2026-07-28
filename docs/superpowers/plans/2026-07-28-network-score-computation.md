# Plan 6 — Network Score Computation

**Depends on:** Plans 1–5 (merged to `main`)  
**Target branch:** `feat/network-score-computation`  
**Goal:** Materialize global VeriRank into `network_scores` / `network_score_history`, emit `score.upsert` / `score.delete` into `sync_events` in the same transaction, and schedule recomputes (debounced after ingest + hourly for time decay).

**Maps to:** productization design §4.5 “Score computation” + §13 step 10.

---

## Context

Plans 1–4 delivered the engine, control-plane ingest, and sync *schema/read* paths. Today:

| Exists | Missing |
|--------|---------|
| `network_scores`, `network_score_history`, `sync_events`, `bootstrap_issuers` tables | Writer that fills them from VeriRank |
| `GET /v1/sync/snapshot` reads `network_scores` | Scores stay empty forever |
| `syncRepository.appendEvent` (own TX + advisory lock) | In-TX allocator usable from score writer |
| Go `trust-engine.RunVeriRank` | Control-plane gRPC client for **RunVeriRank** (Verify stays in-process Node for now) |
| Attestation ingest stores rows | No enqueue / debounce / hourly recompute |

This plan **does not** finish edge sync hardening (step 11–12): no Redis, no WAL, no edge client changes. It only makes scores + sync events real so snapshot/SSE can carry data.

---

## Locked decisions

1. **Scope = step 10 only.** Writing `sync_events` for score changes is in scope (same TX as score writes). Full SSE cursor/heartbeat polish stays Plan 7 / step 11.
2. **Scheduler = in-process** for v1 single-node control plane:
   - Debounce: at most one recompute start per **60s** after ingest marks dirty
   - Periodic: **hourly** recompute even if idle (time decay)
   - Multi-instance / BullMQ+Redis deferred until deploy needs it
3. **RunVeriRank = live gRPC** to `TRUST_ENGINE_ADDR` (default `localhost:9091`). Do **not** reimplement VeriRank in TS.
4. **VerifyAttestation** remains in-process Node crypto (Plan 4 deviation). Unchanged.
5. **Active attestation set:**
   - `superseded_by IS NULL`
   - `issued_at > now() - interval '1800 days'` (10 half-lives)
   - Prefer excluding clearly expired rows where `expires_at IS NOT NULL AND expires_at <= evaluation_time`
6. **`observation_id` grouping (control plane):**
   - Non-empty `observation_id` → one representative edge per `(issuer_id, subject_id, observation_id)` (most restrictive visibility wins: `participants` beats `public`; ties → newest `issued_at`)
   - Empty/null → one edge per `attestation.id` (never collapse)
7. **Roots:** from `bootstrap_issuers` joined to issuers/principals; `Root.weight = current_weight`; principals must include those roots with `is_bootstrap=true`, `trust_weight=1.0`.
8. **Missing bootstrap rows:** if no `bootstrap_issuers`, recompute is a no-op success (log warn) — cold-start seed is step 14.
9. **Diff apply:**
   - Engine row present → upsert `network_scores`; if score/blacklist/reason changed vs previous → insert `network_score_history` + `score.upsert` event
   - Previous score, absent from engine result → delete `network_scores` + `score.delete` event (control plane owns “expired/gone”, not engine `score_reason`)
10. **Retry:** RunVeriRank failures → retry up to 3 times with backoff; then log error and keep last-good `network_scores` (design §7.2).
11. **Migration fix:** add `DEFERRABLE INITIALLY DEFERRED` to `network_scores.principal_id` FK if not already (design §5) via `009_network_scores_fk_deferrable`.

---

## File structure

### New
- `control-plane/src/domains/graph/scoreComputationService.ts` — load graph, group, call gRPC, diff/apply
- `control-plane/src/domains/graph/attestationGraphLoader.ts` — SQL load + observation grouping
- `control-plane/src/domains/graph/scoreWriter.ts` — transactional upsert/delete + history + sync events
- `control-plane/src/domains/graph/recomputeScheduler.ts` — dirty flag, debounce 60s, hourly tick
- `control-plane/src/grpc/runVeriRankClient.ts` — client-streaming RunVeriRank over `@grpc/grpc-js`
- `control-plane/proto/` or reuse committed descriptors — prefer generating from `proto/verilink/trust/v1/trust.proto` with a checked-in JS/TS stub **or** dynamic load; pick one approach in Task 1 and document in PR
- `control-plane/migrations/009_network_scores_fk_deferrable/migration.sql`
- Unit tests: `scoreComputationService.test.ts`, `attestationGraphLoader.test.ts`, `recomputeScheduler.test.ts`
- Integration: `control-plane/src/__tests__/integration/score-recompute.test.ts`

### Modified
- `control-plane/src/domains/attestation/attestationService.ts` — after successful submit, `recomputeScheduler.markDirty()`
- `control-plane/src/domains/sync/syncRepository.ts` — `appendEventWithClient(client, …)` for in-TX use; keep existing `appendEvent` as wrapper
- `control-plane/src/index.ts` — start scheduler on boot; stop on shutdown
- `control-plane/src/config.ts` — `SCORE_RECOMPUTE_DEBOUNCE_MS` (60000), `SCORE_RECOMPUTE_INTERVAL_MS` (3600000), `TRUST_ENGINE_ADDR` already present
- `control-plane/package.json` — add scripts if codegen needed; optional `@grpc/proto-loader` if dynamic loading
- `docs/superpowers/plans/HANDOVER.md` — point next session at Plan 6 execution

---

## Tasks

### Task 1: gRPC RunVeriRank client
- Connect to `config.trustEngine.addr`
- Client-stream: Header → Principals → Roots → Attestations (or any order after header; match Go server: header first)
- Map DB rows → proto fields (`trust_delta`, unix timestamps, `observation_id`)
- Timeouts + structured errors; 3 retries at caller

### Task 2: Graph loader + observation grouping
- SQL: active attestations + all principals needed (issuers, subjects, bootstrap)
- Issuer `trust_weight` / `is_bootstrap` from `issuers`
- Roots from `bootstrap_issuers.current_weight`
- Unit-test grouping edge cases (paired public+participants → one edge; unpaired never merge; mismatch already rejected at ingest)

### Task 3: Score writer (single transaction)
- Advisory lock for sync version allocation (reuse `8392018` or dedicated lock; document)
- Upsert scores; history only on change; append `score.upsert` / `score.delete`
- Set `network_scores.sync_version` / history `sync_version` to the event version written for that principal
- Integration test with Postgres: seed small graph, run apply with fixture ScoreTable, assert tables + sync_events

### Task 4: `scoreComputationService.recomputeNow(evaluationTime?)`
- Compose loader → gRPC → writer
- Empty bootstrap → warn + return
- Empty attestations → still run (roots-only scores) or clear non-root scores per engine output
- Failures: retry 3x; do not wipe scores on failure

### Task 5: Scheduler + ingest hook
- `markDirty()` from `submitAttestation` success path
- Debounce timer coalesces bursts
- Hourly interval always calls `recomputeNow`
- Start/stop wired in `index.ts` graceful shutdown

### Task 6: Integration test (Plan 5 style)
- Requires Postgres + running trust-engine (or testcontainers / `go run` helper)
- Seed bootstrap issuer + principals + one attestation path (3-hop optional)
- Trigger `recomputeNow`
- Assert `network_scores` non-empty for subject; `sync_events` has `score.upsert`
- Optional: second submit → debounce still eventually converges

### Task 7: Docs
- Update `HANDOVER.md` status: Plan 6 in progress / next tasks
- Update shared memory `verilink-productization-arc.md` when merged

---

## Out of scope (next plans)

- Plan 7 / step 11: SSE cursor events, heartbeats, pruning, Redis buffer rebuild
- Plan 8 / step 12: edge sync client consuming scores for allow/deny
- Step 14: bootstrap seeder UI/script (manual SQL seed OK for Plan 6 tests)
- Switching VerifyAttestation to gRPC

---

## Verification

```bash
# Unit
cd control-plane && npm run test:unit

# Integration (Postgres + trust-engine)
# Terminal A: go run ./cmd/trust-engine --grpc-port 9091
# Terminal B:
cd control-plane && npm run test:integration

# Manual smoke
# 1. migrate + start control-plane + trust-engine
# 2. seed bootstrap_issuers + submit attestation
# 3. wait ≤60s (or call internal recompute if exposed in test harness)
# 4. GET /v1/sync/snapshot → scores present
```

CI: existing control-plane integration job; extend with score-recompute test **only if** trust-engine can be started in that job (add Go setup + `go run` background, or tag test `TRUST_ENGINE_ADDR` skip when unset). Prefer skip-when-unset for first PR if CI wiring is heavy; follow-up CI job otherwise.

---

## Suggested PR split

1. **PR A:** loader + writer + gRPC client + unit tests (no scheduler)  
2. **PR B:** scheduler + ingest hook + integration test + docs  

Keep each PR reviewable; A can be validated with direct `recomputeNow` in tests.
