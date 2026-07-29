# Plan 6 — Network Score Computation

**Depends on:** Plans 1–5 (merged to `main`)  
**Target branch:** `feat/network-score-computation`  
**Goal:** Materialize global VeriRank into `network_scores` / `network_score_history`, emit `score.upsert` / `score.delete` into `sync_events` in the same transaction, and schedule recomputes (debounced after ingest + hourly for time decay).

**Maps to:** productization design §4.5 “Score computation” + §13 step 10.

**Review revisions (2026-07-29):** expiry filter mandatory; deactivated principals excluded; `pg_advisory_xact_lock` held through commit; single-flight scheduler with dirty latch; `entity_kind` in change detection; PR B makes live RunVeriRank integration mandatory in CI.

---

## Context

Plans 1–4 delivered the engine, control-plane ingest, and sync *schema/read* paths. Today:

| Exists | Missing |
|--------|---------|
| `network_scores`, `network_score_history`, `sync_events`, `bootstrap_issuers` tables | Writer that fills them from VeriRank |
| `GET /v1/sync/snapshot` reads `network_scores` | Scores stay empty forever |
| `syncRepository.appendEvent` (own TX + session advisory lock unlocks before commit) | In-TX allocator using **transaction-scoped** advisory lock |
| Go `trust-engine.RunVeriRank` (does **not** inspect `expires_at`) | Control-plane gRPC client for **RunVeriRank** + correct pre-filter |
| Attestation ingest stores rows | No enqueue / single-flight / hourly recompute |

This plan **does not** finish edge sync hardening (step 11–12): no Redis, no WAL, no edge client changes. It only makes scores + sync events real so snapshot/SSE can carry data.

---

## Locked decisions

1. **Scope = step 10 only.** Writing `sync_events` for score changes is in scope (same TX as score writes). Full SSE cursor/heartbeat polish stays Plan 7 / step 11.
2. **Scheduler = in-process** for v1 single-node control plane:
   - Debounce: at most one recompute *schedule* per **60s** after ingest marks dirty
   - Periodic: **hourly** recompute even if idle (time decay)
   - **Single-flight (required):** at most one `recomputeNow` in flight; while running, further triggers only set a dirty latch; after completion, if dirty → one immediate rerun; graceful shutdown cancels timers and **awaits** the active run
   - Multi-instance / BullMQ+Redis deferred until deploy needs it
3. **RunVeriRank = live gRPC** to `TRUST_ENGINE_ADDR` (default `localhost:9091`). Do **not** reimplement VeriRank in TS.
4. **VerifyAttestation** remains in-process Node crypto (Plan 4 deviation). Unchanged.
5. **One captured `evaluationTime`** per recompute (JS `Date` / Instant at start of `recomputeNow`):
   - Passed as a bind parameter into **all** loader SQL filters (never `now()` in SQL for these predicates)
   - Passed as the gRPC RunVeriRank header evaluation timestamp
6. **Active attestation set (mandatory filters):**
   - `superseded_by IS NULL`
   - `(expires_at IS NULL OR expires_at > $evaluationTime)` — required; Go engine does not apply expiry
   - `issued_at > $evaluationTime - interval '1800 days'` (10 half-lives)
7. **Active principals only (mandatory):**
   - Roots, issuers, and subjects included in the graph must have `principals.status = 'active'`
   - Edges whose issuer or subject is not active are omitted
   - Bootstrap roots: join `bootstrap_issuers` only to active principals/issuers
   - Rationale: hourly recompute must not recreate scores removed by privacy/deactivation workflows
8. **`observation_id` grouping (control plane):**
   - Non-empty `observation_id` → one representative edge per `(issuer_id, subject_id, observation_id)` (most restrictive visibility wins: `participants` beats `public`; ties → newest `issued_at`)
   - Empty/null → one edge per `attestation.id` (never collapse)
9. **Roots:** from `bootstrap_issuers` joined to active issuers/principals; `Root.weight = current_weight`; principals must include those roots with `is_bootstrap=true`, `trust_weight=1.0`.
10. **Missing bootstrap rows:** if no eligible `bootstrap_issuers`, recompute is a no-op success (log warn) — cold-start seed is step 14.
11. **Diff apply / change predicate:**
    - Engine row present → upsert `network_scores`; treat as changed if any of **`score`, `blacklist`, `reason`, `entity_kind`** differ vs previous → insert `network_score_history` + `score.upsert` event
    - Do **not** assume `entity_kind` is immutable; include it in detection, history payload, and events
    - Previous score, absent from engine result → delete `network_scores` + `score.delete` event (control plane owns “expired/gone/deactivated”, not engine `score_reason`)
12. **Sync-version allocator (correctness):**
    - Score writer opens one DB transaction and immediately runs `SELECT pg_advisory_xact_lock(8392018)` (transaction-scoped; **no** manual unlock)
    - Every `sync_version` allocation for that recompute (`MAX(sync_version)+1` inserts into `sync_events`, and the versions stamped on `network_scores` / history) happens **while that lock is held**, i.e. until the transaction commits or rolls back
    - Refactor `appendEvent` to use `pg_advisory_xact_lock` the same way (session lock + unlock-before-commit is a race: two TXs can compute the same `MAX+1`)
13. **Retry:** RunVeriRank failures → retry up to 3 times with backoff; then log error and keep last-good `network_scores` (design §7.2). Do not apply a partial writer on failed engine calls.
14. **Migration fix:** add `DEFERRABLE INITIALLY DEFERRED` to `network_scores.principal_id` FK if not already (design §5) via `009_network_scores_fk_deferrable`.
15. **CI:** PR A may skip live-engine tests when `TRUST_ENGINE_ADDR` unset. **PR B must start trust-engine in CI** and make the score-recompute integration test **mandatory** before Plan 6 is marked complete.

---

## File structure

### New
- `control-plane/src/domains/graph/scoreComputationService.ts` — capture `evaluationTime`, load graph, group, call gRPC, diff/apply
- `control-plane/src/domains/graph/attestationGraphLoader.ts` — SQL load (expiry + active principals) + observation grouping
- `control-plane/src/domains/graph/scoreWriter.ts` — one TX, `pg_advisory_xact_lock`, upsert/delete + history + sync events
- `control-plane/src/domains/graph/recomputeScheduler.ts` — debounce, hourly tick, **single-flight + dirty latch + awaitable stop**
- `control-plane/src/grpc/runVeriRankClient.ts` — client-streaming RunVeriRank over `@grpc/grpc-js`
- `control-plane/proto/` or reuse committed descriptors — prefer generating from `proto/verilink/trust/v1/trust.proto` with a checked-in JS/TS stub **or** dynamic load; pick one approach in Task 1 and document in PR
- `control-plane/migrations/009_network_scores_fk_deferrable/migration.sql`
- Unit tests: `scoreComputationService.test.ts`, `attestationGraphLoader.test.ts`, `recomputeScheduler.test.ts`, `scoreWriter` lock/version tests
- Integration: `control-plane/src/__tests__/integration/score-recompute.test.ts`

### Modified
- `control-plane/src/domains/attestation/attestationService.ts` — after successful submit, `recomputeScheduler.markDirty()`
- `control-plane/src/domains/sync/syncRepository.ts` — `appendEventWithClient(client, …)` (no lock; caller holds xact lock); rewrite `appendEvent` to one TX + `pg_advisory_xact_lock` (drop session lock/unlock)
- `control-plane/src/index.ts` — start scheduler on boot; on shutdown cancel timers and await in-flight recompute
- `control-plane/src/config.ts` — `SCORE_RECOMPUTE_DEBOUNCE_MS` (60000), `SCORE_RECOMPUTE_INTERVAL_MS` (3600000), `TRUST_ENGINE_ADDR` already present
- `control-plane/package.json` — add scripts if codegen needed; optional `@grpc/proto-loader` if dynamic loading
- `.github/workflows/*` (PR B) — start `cmd/trust-engine` for control-plane integration job; set `TRUST_ENGINE_ADDR`
- `docs/superpowers/plans/HANDOVER.md` — point next session at Plan 6 execution

---

## Tasks

### Task 1: gRPC RunVeriRank client
- Connect to `config.trustEngine.addr`
- Client-stream: Header (with **caller-supplied** `evaluation_time`) → Principals → Roots → Attestations (header first; match Go server)
- Map DB rows → proto fields (`trust_delta`, unix timestamps, `observation_id`)
- Timeouts + structured errors; 3 retries at caller

### Task 2: Graph loader + observation grouping
- Accept `evaluationTime: Date` as required argument
- SQL filters (bind `$evaluationTime`, never SQL `now()` for these):
  - `superseded_by IS NULL`
  - `(expires_at IS NULL OR expires_at > $evaluationTime)`
  - `issued_at > $evaluationTime - interval '1800 days'`
  - issuer and subject principals: `status = 'active'`
- Load principals for the graph: issuers, subjects, bootstrap roots — all `status = 'active'` only
- Issuer `trust_weight` / `is_bootstrap` from `issuers`
- Roots from `bootstrap_issuers.current_weight` joined only to active principals
- Unit tests: expiry boundary, deactivated issuer/subject/root omitted, grouping edge cases (paired public+participants → one edge; unpaired never merge)

### Task 3: Score writer (single transaction)
- `BEGIN` → `SELECT pg_advisory_xact_lock(8392018)` → allocate versions / write scores / history / events → `COMMIT` (lock released only by commit/rollback)
- `appendEventWithClient` must **not** take or release any advisory lock
- Change detection includes **`entity_kind`** alongside score, blacklist, reason
- Integration/unit: concurrent writers cannot allocate duplicate `sync_version`; stale session-lock pattern is gone from `appendEvent`

### Task 4: `scoreComputationService.recomputeNow(evaluationTime?)`
- Default `evaluationTime = new Date()` once at entry; use that value for loader **and** gRPC header
- Compose loader → gRPC → writer
- Empty eligible bootstrap → warn + return
- Empty attestations → still run (roots-only / engine output); deletes apply for principals that disappear
- Failures: retry 3x on gRPC; do not wipe or partially write scores on failure

### Task 5: Scheduler + ingest hook (single-flight)
- State: `running`, `dirty`, debounce timer, hourly timer, optional `AbortSignal` / completion promise for stop
- `markDirty()` from `submitAttestation` success path → schedule debounce if not already scheduled
- Hourly interval marks dirty / requests run (same entry path as debounce)
- Entry path:
  1. If `running` → set `dirty=true` and return
  2. Else set `running=true`, clear `dirty`, capture `evaluationTime`, await `recomputeNow`
  3. On settle: if `dirty` → clear dirty and loop immediately (do not wait for debounce)
  4. Else set `running=false`
- `stop()`: clear/cancel timers; await current in-flight run (including dirty-loop drain or cancel mid-loop after current iteration — prefer drain one dirty rerun then exit); do not leave orphaned writes
- Wire start/stop in `index.ts` graceful shutdown
- Unit tests: concurrent markDirty + hourly while running → exactly one follow-up run; stop awaits completion

### Task 6: Integration test + CI (mandatory in PR B)
- **PR A:** may gate live-engine cases on `TRUST_ENGINE_ADDR` (skip when unset) for local/unit velocity
- **PR B (Plan 6 complete gate):**
  - CI starts `go run ./cmd/trust-engine` (or built binary) and exports `TRUST_ENGINE_ADDR`
  - `score-recompute.test.ts` is **required** (no skip path in CI)
  - Seed active bootstrap + principals + attestation; assert scores + `score.upsert`
  - Cases: expired attestation excluded; deactivated principal does not regain a score; second submit converges via dirty latch

### Task 7: Docs
- Update `HANDOVER.md` status: Plan 6 in progress / next tasks
- Update shared memory `verilink-productization-arc.md` when merged

---

## Out of scope (next plans)

- Plan 7 / step 11: SSE cursor events, heartbeats, pruning, Redis buffer rebuild
- Plan 8 / step 12: edge sync client consuming scores for allow/deny
- Step 14: bootstrap seeder UI/script (manual SQL seed OK for Plan 6 tests)
- Switching VerifyAttestation to gRPC
- Multi-instance score workers (Redis/BullMQ)

---

## Verification

```bash
# Unit (includes scheduler single-flight + loader filters + writer lock semantics)
cd control-plane && npm run test:unit

# Integration (Postgres + trust-engine) — required for PR B / Plan 6 done
# Terminal A: go run ./cmd/trust-engine --grpc-port 9091
# Terminal B:
cd control-plane && npm run test:integration

# Manual smoke
# 1. migrate + start control-plane + trust-engine
# 2. seed bootstrap_issuers + submit attestation
# 3. wait ≤60s (or call recomputeNow in harness)
# 4. GET /v1/sync/snapshot → scores present
# 5. expire or deactivate → next recompute removes score + score.delete
```

---

## Suggested PR split

1. **PR A:** loader (expiry + active principals + shared `evaluationTime`) + writer (`pg_advisory_xact_lock`) + gRPC client + unit tests; live-engine integration optional/skippable when unset  
2. **PR B:** single-flight scheduler + ingest hook + **mandatory** CI trust-engine + score-recompute integration + docs; Plan 6 complete only when this lands green  

Keep each PR reviewable; A can be validated with direct `recomputeNow` in tests.
