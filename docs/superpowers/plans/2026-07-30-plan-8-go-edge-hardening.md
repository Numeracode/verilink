# Plan 8 — Go edge hardening (SSE client + snapshot + WAL)

**Depends on:** Plans 1–7 (merged to `main`, including PR #16)  
**Status:** **DONE** — PR A (#18), PR B (#20), PR C (#21) merged. Next: dashboard (§13 step 13).  
**Target branch:** `feat/go-edge-hardening` (historical; work landed via split PRs)  
**Goal:** Wire the Go edge verifier to the control-plane sync surface: versioned SSE client, atomic in-memory snapshot (scores/keys/policy), atomic on-disk snapshot persistence, and a bounded local decision WAL with flush + drop metrics.

**Maps to:** productization design §4.5 (edge sync + decision path), §4.7 (degraded modes), §13 step 12.

**Inherited contracts (do not reopen):** Plan 7 Decisions 3, 12, 16 (`429` backlog vs `410` retention; named `event: shutdown`; resume via snapshot `highWaterVersion`).

---

## Review findings closure

All actionable comments from Qodo on PR #17 are locked below. Implementation must satisfy every row.

| Source | Finding | Locked where |
|--------|---------|--------------|
| Qodo | HANDOVER pointed at non-existent `docs/plan-8-go-edge-hardening` | `HANDOVER.md` header (this PR) |
| Qodo | SSE `retry:` unit unspecified | Decision 5 |
| Qodo | Disk snapshot omit directory fsync after rename | Decision 8; Task 3; Decision 12 |

---

## Context

Plan 3 delivered RFC 9421 three-way outcomes on `cmd/edge-verifier`. Plan 6–7 made control-plane scores + long-lived SSE real. The edge still runs on **MVP stubs**:

| Exists | Missing |
|--------|---------|
| `internal/edgeverifier` reverse proxy + signature verify | Control-plane HTTP client (`/v1/sync/snapshot`, `/v1/sync/events`) |
| `pkg/verifier.MockTrustStore` (fingerprint → score) | Atomic **immutable** snapshot: principal scores + keys + tenant policy |
| `requestsigin.AgentRegistry` loaded from static JSON | Keys applied from snapshot / `key.upsert` / `key.revoke` with validity windows |
| Unsigned allow/deny via `-require-signatures` | Full policy fields (`threshold`, `unsigned_action`, `fail_open_expired`, `max_snapshot_age_seconds`, …) |
| Control-plane SSE + `429`/`shutdown`/cursor semantics | Go SSE consumer (Last-Event-ID, backoff, shutdown, snapshot recovery) |
| `decision_*` tables + batch idempotency schema | Bounded local decision WAL + batch flush to control plane |
| Design §4.7 degraded modes | Stale / unreachable mode headers + fail-closed `503` |

Plan 8 **does not** redo RFC 9421 (already Plan 3). It replaces mock trust/key sources with synced state and adds decision durability.

---

## Locked decisions

1. **Scope = design §13 step 12 (edge sync + WAL), not dashboard/bootstrap/deploy.** RFC 9421 path stays; swap data sources under it.
2. **Package layout (Go):** expand `internal/edgeverifier/` (flat service package, same pattern as `internal/trustengine/`), thin wiring in `cmd/edge-verifier`. Keep reusable crypto/signing in `pkg/`. Suggested files:
   - `proxy.go` — existing; consult snapshot + policy; append decisions to WAL
   - `snapshot.go` — immutable snapshot + `atomic.Pointer` swap; LookupScore / LookupKey / Policy
   - `apply.go` — ApplySnapshot / ApplyEvent; idempotent by `sync_version`
   - `sse.go` — Last-Event-ID loop, ping freshness, shutdown, `410`/`429` recovery
   - `cpclient.go` — authenticated snapshot GET (+ gzip); decision-batch POST when ready
   - `disk.go` — atomic tmp→rename persist/load
   - `wal.go` — bounded decision WAL + flush worker
   - `policy.go` — threshold / unsigned / stale modes from synced policy
   - Do **not** put SSE/WAL in `pkg/` unless another binary needs them. Optional later: shared DTO package if CP/edge need one schema — not required for v1.
   - **Design tension:** today's fingerprint-keyed `MockTrustStore` vs identity-from-`keyid` + principal scores — grow a `SnapshotStore` (or equivalent) rather than overloading `MockTrustStore`.
3. **Auth to control plane:** edge uses a tenant API key (`Authorization: Bearer vrl_…`). Sync routes today are `apiKeyOnly` (any valid key for the tenant — no extra scope gate). Config: `VERILINK_CONTROL_PLANE_URL`, `VERILINK_API_KEY`. Do not invent new scopes in Plan 8 unless a gate is added on the CP side.
4. **Bootstrap sequence on edge start:**
   1. If a valid on-disk snapshot exists → load into memory (atomic swap), set cursor = `highWaterVersion`
   2. Else → `GET /v1/sync/snapshot` (gzip accepted), apply atomically, persist to disk, set cursor
   3. Open SSE `GET /v1/sync/events` with `Last-Event-ID: <cursor>` and `Accept: text/event-stream`
5. **SSE client behavior (implements Plan 7 Decision 16 + 12):**
   - Parse SSE frames; honor `retry:` preamble as base reconnect delay
   - **`retry:` units = milliseconds** (Plan 7 emits `retry: <SYNC_SSE_POLL_INTERVAL_MS>`). Parse as a non-negative integer milliseconds value. If `retry:` is missing, non-numeric, negative, or zero → default base delay **`5000` ms** (same as control-plane poll default). Cap exponential backoff at **30000 ms**.
   - Handle durable events: `score.upsert`, `score.delete`, `key.upsert`, `key.revoke`, `policy.replace`
   - Handle non-durable `event: cursor` — advance resume cursor only (no state mutation beyond cursor)
   - Ignore SSE comments (`: ping`) except as **freshness bytes** (reset stale timer)
   - **`event: shutdown`:** stop reading; close connection; reconnect with exponential backoff (base = parsed `retry` ms, cap 30s) after drain — do **not** treat as fatal
   - **`429` + `X-Verilink-Sync-Reason: backlog-cap` (or problem+json):** fetch full snapshot → atomic swap → disk persist → reconnect SSE with `Last-Event-ID = snapshot.highWaterVersion`
   - **`410 Gone`:** same recovery as `429` (retention path; may be rare until pruning ships)
   - **`503` / network errors:** backoff reconnect; if last authenticated bytes still within `max_snapshot_age_seconds`, serve in **degraded** mode; if stale, fail-closed unless `fail_open_expired`
   - Event apply must be **idempotent** (re-applying the same `sync_version` is a no-op). Snapshot refresh window may briefly duplicate versions already applied — skip if `sync_version <= applied_hw`
6. **In-memory snapshot:**
   - Immutable map(s) behind `atomic.Pointer` (or equivalent) — readers never see a half-applied update
   - Contains: scores by `principal_id` (score, blacklisted, score_reason, entity_kind), active keys by `key_id` (principal, raw pubkey, validity window), active tenant policy
   - **Cache miss = unknown**, never fall back to a previous generation after a successful swap
   - Key lookup for signatures uses snapshot keys; enforce `valid_from` / `valid_until` locally (reject as unknown-key outside window)
7. **Freshness / degraded modes (design §4.7):**
   - Freshness = time since last **authenticated** bytes on the SSE stream (event, cursor, or `: ping`)
   - Stale if age > policy `max_snapshot_age_seconds` (default 300, clamp 60–1800)
   - Stale + `fail_open_expired=false` → request path returns **503** with `X-Verilink-Mode: stale`
   - Stale + `fail_open_expired=true` → serve with `X-Verilink-Mode: expired`
   - Unreachable but not stale → serve with `X-Verilink-Mode: degraded`
8. **Atomic disk snapshots:**
   - Path configurable (`VERILINK_SNAPSHOT_PATH`, default under data dir)
   - Durability sequence (crash-safe on common filesystems):
     1. Write payload to `snapshot.json.tmp` (or `.gz`) in the same directory as the live file
     2. `fsync` the temp file
     3. `rename` temp → live name (atomic replace)
     4. **`fsync` the containing directory** so the directory entry for the rename is durable (omitting this can lose the rename across power loss even after a successful file fsync)
   - Persist after initial fetch, after successful `429`/`410` recovery snapshot, and periodically after N durable applies or T seconds (defaults: every **100** durable events or **60s**, whichever first — mirror control-plane cursor cadence)
   - On-disk format includes `highWaterVersion` + scores + keys + policy; version the envelope (`schema_version: 1`)
9. **Identity / scoring path upgrade (minimal for step 12):**
   - Prefer resolving trust from **verified `keyid` → principal → network score** (design §4.3), not fingerprint-as-identity
   - Fingerprints remain for allow/deny list matching + telemetry headers only
   - Plan 8 must stop depending on `MockTrustStore` seeded fingerprints for allow/deny of signed agents once snapshot scores exist; unknown principal → score 0 + policy default
   - Keep existing RFC 9421 verify / nonce / unsigned paths
10. **Decision WAL (local):**
    - Append-only records with monotonic per-edge `wal_seq`
    - Fields needed for later control-plane ingest: fingerprint, principal_id (nullable), score, blacklisted, score_reason, action (`allow`/`deny`/`passthrough`), decided_at
    - Default `wal_max_bytes = 256 MiB`; on full → **drop oldest** + increment `decisions_dropped_total` (Prometheus counter)
    - Enterprise `no_drop_decisions` (from policy or flag): block writers when full; size via `max(8 GiB, ceil(p99_wal_bytes/s × required_outage_seconds × 1.5))` with `required_outage_seconds` default **900** (independent of snapshot age)
    - Flush worker: batch by count/time with `batch_id` + `payload_hash`; POST to control-plane decision ingest when the route exists
    - **v1 pragmatism (executed):** PR B shipped WAL + metrics + stub flush transport; PR C (#21) wired `POST /v1/decisions/batch` + HTTP flush. Schema for `decision_*` already existed (migration 006).
11. **Config flags (edge):**
    - `VERILINK_CONTROL_PLANE_URL` (required for sync mode)
    - `VERILINK_API_KEY` (required for sync mode)
    - `VERILINK_SNAPSHOT_PATH`
    - `VERILINK_WAL_PATH` / `VERILINK_WAL_MAX_BYTES`
    - `VERILINK_NO_DROP_DECISIONS` (bool; can be overridden by synced policy when present)
    - `VERILINK_SYNC_ENABLED` (default true when URL+key set; false keeps MVP mock mode for local demos)
    - Existing: `-external-base-url`, `-require-signatures`, `-agent-keys-path` (agent-keys-path becomes **bootstrap-only / override** once sync keys land — document precedence: synced keys win when sync enabled)
12. **Testing:**
    - Unit: SSE parser (ping / cursor / durable / shutdown; `retry:` ms parse + invalid fallback), snapshot atomic swap, idempotent apply, disk rename crash-safety (temp → file fsync → rename → **dir fsync**), WAL drop-oldest + counter, stale mode gating
    - Integration: edge against control-plane harness (or `httptest`) with fixture SSE + snapshot; assert `429` recovery reconnects at `highWaterVersion`; assert shutdown reconnects
    - Do **not** require live trust-engine for pure sync-client tests
13. **Metrics (minimum):** `sse_bytes_age_seconds`, `snapshot_high_water`, `decisions_dropped_total`, `wal_bytes`, `sync_reconnects_total{reason=…}`
14. **Out of scope:** dashboard (step 13), bootstrap seed (step 14), Helm/Docker polish beyond flags needed to run, Redis, pruning/`410` generation on CP, mTLS

---

## Tasks

### Task 1: Immutable snapshot store

- `internal/edgeverifier/snapshot.go` with atomic swap
- Lookups: score by principal, key by keyid, policy getters
- Unit tests for swap visibility and miss-as-unknown

### Task 2: Control-plane sync client + SSE loop

- `cpclient.go` + `sse.go` + `apply.go`
- Snapshot GET (gzip), SSE GET with Last-Event-ID
- Event apply + cursor tracking + shutdown / 429 / 410 / backoff
- Wire freshness clock from any received stream bytes

### Task 3: Disk snapshot persistence

- `disk.go`: atomic write path per Decision 8 (temp write → file fsync → rename → **directory fsync**); load on boot; schema_version envelope
- Unit: crash-safety sequence includes directory fsync after rename

### Task 4: Proxy integration

- Replace MockTrustStore / static registry usage when sync enabled (`SnapshotStore` + synced keys)
- Enforce policy thresholds + unsigned_action + stale modes + response headers (`X-Verilink-Mode`, trust headers)
- Record decisions into WAL interface

### Task 5: Decision WAL

- `wal.go`: bounded store, drop-oldest or no-drop, metrics
- Flush worker + transport interface (real HTTP when CP route ready; stub OK for PR A)

### Task 6: cmd/edge-verifier wiring + flags

- Sync mode vs demo mock mode
- Graceful shutdown: cancel SSE, flush WAL best-effort

### Task 7: Tests + docs

- Units + integration as Decision 12; extend `internal/testutil/edge_verifier.go` with injectable snapshot / fake CP when useful
- Update `HANDOVER.md` + shared memory when Plan 8 lands

---

## Suggested PR split

1. **Docs PR (this):** Plan 8 locked decisions + HANDOVER pointer
2. **PR A:** `internal/edgeverifier` snapshot + apply + SSE/cpclient + disk + proxy read-path integration + units
3. **PR B:** WAL + flush interface + metrics + integration tests against CP sync fixtures
4. **PR C (optional / if blocked):** control-plane decision batch ingest HTTP route wiring to existing `decision_*` tables — only if not already present when PR B starts

---

## Verification

```bash
go test ./internal/edgeverifier/... ./cmd/edge-verifier/...
go test -tags=integration ./cmd/edge-verifier/...   # when harness extended
go vet ./...
```

Manual smoke (local CP + edge):

1. Start control-plane with seeded scores
2. Start edge with URL + API key → loads snapshot → SSE connects
3. Trigger recompute / insert sync event → edge applies without restart
4. Force backlog `429` (small `SYNC_SSE_MAX_INITIAL_BATCH`) → edge recovers via snapshot
5. SIGTERM control-plane SSE → edge sees `shutdown` and reconnects

---

## Known risks

- **Snapshot refresh window** (Plan 7): duplicate/skipped handling via idempotent apply + cursor ≤ applied_hw
- **Decision ingest API** may lag; WAL must not silently discard without metrics even if flush is stubbed
- **Large snapshots:** gzip helps; streaming decode if memory becomes an issue (not expected at v1)
- **Static `-agent-keys-path` vs synced keys:** document override rules to avoid split-brain during migration
