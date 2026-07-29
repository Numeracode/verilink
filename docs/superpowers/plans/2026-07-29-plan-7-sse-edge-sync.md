# Plan 7 — SSE edge sync

**Depends on:** Plans 1–6 (merged to `main`)  
**Target branch:** `feat/sse-edge-sync`  
**Goal:** Turn `GET /v1/sync/events` from a one-shot batch into a long-lived SSE stream with `: ping` heartbeats, `410 Gone` on pruned cursor, per-tenant `policy.replace` filtering, and non-durable cursor events so edges never receive a stale `Last-Event-ID`.

**Maps to:** productization design §4.5 steps 3–5, §13 step 11.

**Review revisions (2026-07-29):** cursor event frequency tightened to every poll cycle; snapshot compression scoped to non-SSE routes only with flush strategy; snapshot-consistent high-water for cursor events; connection limits and backpressure noted; graceful shutdown for SSE draining; sync_cursors write hardened; CI trust-engine requirement explicit; bootstrap cursor `0` rule; poll-delivered wording; monotonic `sync_cursors`; per-connection SSE write backpressure; bounded initial-batch probe; strict `Last-Event-ID` parsing; empty-table `COALESCE` high-water; shutdown control-frame priority; bootstrap cursor emission on connect; persist `last_emitted_hw` only (no future client cursor).

---

## Review findings closure

All actionable comments from human review, CodeRabbit, and Qodo on PR #14 are locked below. Implementation must satisfy every row.

| Source | Finding | Locked where |
|--------|---------|--------------|
| Human | Cursor event frequency underspecified — should fire every poll cycle when high-water advances | Decision 4 (revised) |
| Human / Qodo | Snapshot compression middleware will buffer SSE if applied globally | Decision 9 (revised); Task 4 (revised) |
| Human | No connection limits or backpressure | Decision 12 |
| Human | Integration test CI needs trust-engine sidecar | Decision 13 |
| Human | sync_cursors disconnect write may be lossy | Decision 11; Task 6 |
| Qodo | Cursor jump skips events if high-water read not in same snapshot | Decision 14; Task 1 |
| CodeRabbit | “Pushed as committed” vs polling | Decision 1; Decision 8 |
| CodeRabbit | 410/cursor `0` vs `MIN(sync_version)` inconsistent; pruning tests premature | Decision 3; Task 5; Verification |
| CodeRabbit | `sync_cursors` updates must be monotonic | Decision 11; Task 6 |
| CodeRabbit | Per-connection `res.write()` backpressure | Decision 12; Task 1; Task 7 |
| CodeRabbit | HANDOVER Plan 6 still IN PROGRESS | `HANDOVER.md` (this PR) |
| CodeRabbit | Bounded initial-batch probe before materializing events | Decision 12; Task 1 |
| CodeRabbit | Shutdown frame must not be dropped when queue full | Decision 12; Task 7 |
| CodeRabbit | Strict `Last-Event-ID` integer parsing | Decision 15; Task 1 |
| CodeRabbit | Empty `sync_events` → high-water `0` | Decision 14; Task 1 |
| CodeRabbit | Empty-table cursor vs “only when hw advances” | Decision 4 (bootstrap emission); Task 1; Task 5 |
| CodeRabbit | Do not persist client `Last-Event-ID` ahead of high-water | Decision 11; Task 1; Task 6 |

---

## Context

Plan 6 landed the score writer that appends `score.upsert` / `score.delete` into `sync_events` inside the same transaction as score writes. The snapshot endpoint (`GET /v1/sync/snapshot`) already returns `highWaterVersion` from a repeatable-read image. But the `/v1/sync/events` route today reads events once, writes a single non-durable `cursor` event at the high-water mark, and closes — it is **not** a long-lived SSE stream.

What's missing:

| Exists | Missing |
|--------|---------|
| `sync_events` table with `sync_version` monotonic allocator | Long-lived SSE connection (`Connection: keep-alive`, `: ping` heartbeats) |
| `GET /v1/sync/events` one-shot batch | `Last-Event-ID` support + retention `410 Gone` (when pruning exists) |
| Per-tenant filtering (`tenant_id IS NULL OR tenant_id = $2`) | Non-durable cursor events between tenant-filtered gaps |
| `sync_cursors` table (migration 005) | Cursor tracking per connected edge node |
| Edge verifier Go binary (Plan 3) | Go SSE client in edge + atomic snapshot swap |
| Snapshot endpoint with `high_water_version` | Compressed (gzip) snapshot response |

---

## Locked decisions

1. **SSE stream = long-lived HTTP connection** with `text/event-stream`. The edge opens `GET /v1/sync/events?last_event_id=<version>` with `Accept: text/event-stream`. **Delivery is poll-based** (default every 5s): events appear on the stream after the next poll cycle, not at Postgres commit time (no Redis/notify in Plan 7).
2. **Heartbeats are SSE comment lines** (`: ping\n\n`), not durable rows. Interval: configurable, default **30 seconds**. The edge uses bytes-received-on-stream as the freshness signal.
3. **`410 Gone` — three distinct cases (do not conflate):**
   - **Bootstrap (never 410):** missing `Last-Event-ID`, `?last_event_id=0`, or header `Last-Event-ID: 0` means “start from the beginning.” Stream tenant-filtered events with `sync_version > 0`. A non-empty `sync_events` table with cursor `0` is valid and must **not** return 410.
   - **Retention / pruned cursor (deferred in Plan 7):** when event pruning ships, return 410 only if `last_event_id > 0` **and** `last_event_id < retention_floor_version` (oldest retained `sync_version`). **Do not** use `last_event_id < MIN(sync_version)` while pruning is disabled — that breaks bootstrap semantics.
   - **Backlog cap (Plan 7):** if `last_event_id > 0` and the tenant-filtered backlog **count** exceeds `SYNC_SSE_MAX_INITIAL_BATCH`, return `410 Gone` and force a full snapshot refresh. **Detection must use a bounded probe** (`LIMIT SYNC_SSE_MAX_INITIAL_BATCH + 1` with tenant predicate) — never load an unbounded backlog into memory (bootstrap `0` on a large table is especially dangerous).
4. **Non-durable cursor events (revised):** to advance `Last-Event-ID` across tenant-filtered gaps, the stream sends `event: cursor\nid: <high_water_version>\ndata: {}\n\n`. This is SSE-only — no row in `sync_events`. Track **`last_emitted_hw`** per connection. **Bootstrap:** immediately after the first snapshot-consistent `hw` read on connect (Decision 14), emit one cursor with `id: <hw>` — including `id: 0` when `sync_events` is empty — then set `last_emitted_hw = hw`. **Ongoing:** on every poll cycle where `hw > last_emitted_hw`, emit a cursor and set `last_emitted_hw = hw` (not only during heartbeats). This keeps `Last-Event-ID` within one poll interval of the true high-water, regardless of whether durable events were tenant-visible.
5. **Per-tenant filtering:** `score.upsert`, `score.delete`, `key.upsert`, `key.revoke` → all tenants. `policy.replace` → only the owning tenant. This is the existing repository filter.
6. **Event pruning:** not in scope for Plan 7. Events accumulate. Pruning (+ `410 Gone` enforcement) can be added in a follow-up once retention policy is set.
7. **No Redis** in Plan 7. The SSE stream polls Postgres. A Redis pub/sub notify layer for instant push can be added post-v1 when connection count warrants it.
8. **Polling interval for new events:** configurable, default **5 seconds**. The SSE handler polls `sync_events WHERE sync_version > $cursor` on a timer. Worst-case latency from commit to edge-visible bytes is one poll interval (plus network), unless post-v1 notify is added.
9. **Snapshot compression (revised):** `GET /v1/sync/snapshot` supports gzip via `Accept-Encoding`. **Compression middleware must be scoped to the snapshot route only** — it must **not** wrap the SSE `/v1/sync/events` response. SSE responses must not be compressed (buffering breaks heartbeat freshness guarantees). For snapshot, use `compression({ flush: zlib.Z_SYNC_FLUSH })` so large snapshot payloads stream without excessive buffering.
10. **Edge sync client (Go):** deferred to Plan 8 / step 12. Plan 7 delivers the control-plane streaming endpoint; the Go edge client consumes it in the next step.
11. **`sync_cursors` persistence:** the control-plane writes `last_cursor` per edge_node periodically (every 60s or 100 events) and on disconnect (best-effort). **Persist only server-observed progress** — the connection’s `last_emitted_hw` (and durable events applied on the stream), **never** a raw client `Last-Event-ID` that exceeds current global `high_water` (avoids negative lag / “future cursor” stuck via `GREATEST`). **All upserts must be monotonic:** `last_cursor = GREATEST(sync_cursors.last_cursor, EXCLUDED.last_cursor)` with `EXCLUDED.last_cursor <= high_water` at write time. Failures are logged as warnings, not thrown. Informational for Plan 7 (monitor lag); stream resume uses edge `Last-Event-ID`, not this table.
12. **Connection limits and backpressure:**
    - Configurable max concurrent SSE connections per control-plane instance: `SYNC_SSE_MAX_CONNECTIONS` (default 100). New connections beyond this limit receive `503 Service Unavailable`.
    - Initial batch cap: bounded probe as in Decision 3; 410 when count > `SYNC_SSE_MAX_INITIAL_BATCH`.
    - **Per-connection write backpressure:** admission caps are not enough. Each SSE connection maintains a **bounded outbound queue** for data frames (default max `SYNC_SSE_WRITE_QUEUE_MAX` = 256). **Reserve one slot (or a dedicated control lane) for shutdown** so `: shutdown\n\n` is always accepted even when the data queue is full — never drop or reject shutdown. Heartbeats and cursor events use the data queue; on overflow, apply slow-client policy (`drain` wait, then close after `SYNC_SSE_SLOW_CLIENT_MS`). If `res.write()` returns false, pause dequeuing until `drain`.
    - Graceful shutdown: on SIGTERM/SIGINT, stop accepting new SSE connections; **prepend or priority-enqueue** `: shutdown\n\n` on each connection (guaranteed delivery per reserved slot); flush with drain timeout (default 5 seconds); then close. SSE cleanup **before** `server.close()` and `pool.end()`.
    - Reconnection storm mitigation: `retry: <SYNC_SSE_POLL_INTERVAL_MS>\n` in the SSE preamble; edges use exponential backoff client-side.
    - v1 safety rails; Redis pub/sub (post-v1) changes scaling profile.
13. **CI trust-engine requirement (new):** Plan 7 integration tests seed scores via `recomputeNow`, which requires a live trust-engine. CI already starts trust-engine as a sidecar (Plan 6 PR B). Plan 7 integration tests reuse this CI setup — no mocking. The `TRUST_ENGINE_ADDR` env var is mandatory in CI for these tests.
14. **Snapshot-consistent high-water for cursor events:** each poll cycle must read tenant-filtered events **and** global high-water from the **same query or snapshot** (CTE or single statement). High-water is **`COALESCE(MAX(sync_version), 0)`** over `sync_events` (empty table → `0`, not SQL `NULL`). Use that value for cursor event `id`, comparisons, and serialization. This prevents skipped events and defines empty-table bootstrap behavior.
15. **`Last-Event-ID` parsing:** parse header or `?last_event_id=` as a **non-negative integer** (`sync_version`). Missing → `0` (bootstrap). Reject with **400 Bad Request**: negative values, non-numeric strings, decimals, empty after trim, or values outside safe integer range (use `BigInt` or decimal string compare for IDs > `Number.MAX_SAFE_INTEGER` — do not use `parseFloat`). Apply validation **before** backlog probe, 410 logic, or DB queries.

---

## Tasks

### Task 1: SSE long-lived stream handler

Rewrite `GET /v1/sync/events`:
- Check active SSE connection count; if >= `SYNC_SSE_MAX_CONNECTIONS`, respond `503`.
- Read `Last-Event-ID` from header (per SSE spec) or `?last_event_id` query param (backwards compat); header wins. **Parse per Decision 15** (400 on invalid).
- **Never 410 for bootstrap cursor `0`** (Decision 3).
- If `last_event_id > 0` and pruning enabled and `last_event_id < retention_floor_version`: respond `410 Gone` (**Plan 7:** pruning disabled — skip this branch in implementation and tests).
- If `last_event_id > 0`: run **bounded backlog probe** — tenant-filtered `sync_version > last_event_id` with `ORDER BY sync_version ASC LIMIT SYNC_SSE_MAX_INITIAL_BATCH + 1`. If more than `SYNC_SSE_MAX_INITIAL_BATCH` rows would match, respond `410 Gone` without loading the full backlog.
- Set `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`, `X-Accel-Buffering: no`.
- Attach per-connection **bounded write queue** (Decision 12) with **shutdown slot reserved**; data frames, heartbeats, and cursor events use the data queue.
- Write SSE preamble: `retry: <SYNC_SSE_POLL_INTERVAL_MS>\n\n`.
- Flush initial batch from the bounded probe result (at most `SYNC_SSE_MAX_INITIAL_BATCH` rows). First poll/read returns events plus `hw = COALESCE(MAX(sync_version), 0)` in the same CTE/statement (Decision 14).
- **Bootstrap cursor (Decision 4):** after that first `hw` read, emit `event: cursor` with `id: <hw>` and set `last_emitted_hw = hw` (empty table → `id: 0`).
- Enter poll loop: sleep `SYNC_SSE_POLL_INTERVAL_MS` (default 5000), query new events + `COALESCE(MAX(sync_version),0)` atomically, enqueue data frames; when `hw > last_emitted_hw`, emit cursor and update `last_emitted_hw`. Enqueue `: ping\n\n` every `SYNC_SSE_HEARTBEAT_INTERVAL_MS` (default 30000).
- On client disconnect (`req.on('close')`): best-effort monotonic `sync_cursors` upsert using **`last_emitted_hw`** (Decision 11), drain/close queue, clean up timers.
- **req.socket.setNoDelay(true)** for minimal latency.

### Task 2: Heartbeat timer

- Independent `setInterval` per SSE connection.
- Enqueues `: ping\n\n` on the connection write queue (SSE comment, not a named event).
- Must survive even if no new events arrive.
- Clean up on disconnect.

### Task 3: Config additions

- `SYNC_SSE_POLL_INTERVAL_MS` (default 5000)
- `SYNC_SSE_HEARTBEAT_INTERVAL_MS` (default 30000)
- `SYNC_SSE_MAX_CONNECTIONS` (default 100)
- `SYNC_SSE_MAX_INITIAL_BATCH` (default 10000)
- `SYNC_SSE_WRITE_QUEUE_MAX` (default 256)
- `SYNC_SSE_SLOW_CLIENT_MS` (default 60000)

### Task 4: Snapshot compression (revised)

- Add `compression` middleware **only to the snapshot route** (`GET /v1/sync/snapshot`), configured with `{ flush: zlib.Z_SYNC_FLUSH }` for streaming-friendly compression.
- **Do not apply compression to the SSE route.** SSE responses must be sent uncompressed to avoid buffering heartbeats and events.
- Verify `GET /v1/sync/snapshot` returns gzipped when client sends `Accept-Encoding: gzip`.
- Unit test: SSE route does not have `Content-Encoding: gzip` header.

### Task 5: Integration test

- `control-plane/src/__tests__/integration/sse-sync.test.ts`
- **Requires `TRUST_ENGINE_ADDR`** (same CI setup as Plan 6 score-recompute tests).
- Seed bootstrap + attestation + recompute → connect SSE → assert `score.upsert` events arrive.
- Assert `: ping` heartbeat within interval.
- Assert non-durable cursor event after batch, with `id` matching high-water.
- Assert bootstrap: no `Last-Event-ID` (or `0`) on non-empty `sync_events` returns **200** stream, not 410.
- Assert empty `sync_events`: stream starts; **bootstrap** cursor event has `id: 0` (Decision 4 + Decision 14).
- Assert `400` for malformed `Last-Event-ID` (negative, non-numeric, fractional); oversized ID handled without precision loss.
- Assert `410 Gone` when backlog > max initial batch (seed or lower config; probe uses LIMIT+1).
- **Deferred:** retention/pruned-cursor 410 tests until pruning ships (Decision 6).
- Assert `503` when max connections exceeded.
- Assert tenant filtering: tenant B does not receive tenant A `policy.replace`.
- Assert client disconnect cleans up (no leaked timers / intervals).
- Assert graceful shutdown sends `: shutdown` and closes connections.

### Task 6: Sync cursor tracking

- **Periodic persistence:** every 60 seconds or 100 events (whichever first), upsert `last_cursor = GREATEST(last_cursor, $last_emitted_hw)` where `$last_emitted_hw <= high_water` (Decision 11), in try/catch (failures logged).
- On disconnect: same monotonic upsert from connection `last_emitted_hw`, best-effort + warning on failure.
- Unit/integration: client `Last-Event-ID` far ahead of `hw` does not inflate `sync_cursors.last_cursor` until the stream emits that position.
- Add `GET /v1/admin/sync/lag` (staff-only) returning per-edge lag = `high_water_version - last_cursor`.

### Task 7: SSE connection lifecycle + graceful shutdown

- Track active SSE connections in a `Set` (or similar) on the server.
- On SIGTERM/SIGINT (`index.ts`): stop accepting new SSE; **priority-enqueue shutdown** on each connection (reserved slot — never dropped when data queue full); wait for queue drain / timeout; **before** `server.close()` and `pool.end()`.
- Expose active connection count for the 503 gate and monitoring.
- Unit tests: slow client disconnected after `SYNC_SSE_SLOW_CLIENT_MS`; **shutdown delivered when data queue is full**.

### Task 8: Docs

- Update `HANDOVER.md` status: Plan 7 → in progress / complete.
- Update shared memory.

---

## Known risks (deferred)

These are acknowledged operational risks that are not addressed in Plan 7 but must be solved before high-scale deployment:

- **Event pruning:** unbounded `sync_events` growth. Pruning + `410 Gone` enforcement deferred until retention policy is set.
- **Connection scaling:** 100 SSE connections per instance is sufficient for v1. Redis pub/sub + horizontal scaling needed for >>100 edges.
- **Network partitions:** a half-open TCP connection can keep a slot occupied. The heartbeat timer + client-side timeout mitigate this partially; server-side idle detection can be added.
- **Large snapshot payloads:** gzip helps, but very large graphs may need streaming JSON or pagination. Not expected at v1 scale.

---

## Out of scope (next plans)

- **Plan 8 / step 12:** Go edge SSE client, atomic in-memory snapshot, bounded WAL, atomic disk snapshots
- **Plan 9 / step 13:** Dashboard
- Event pruning / retention policy
- Redis pub/sub for instant event push (post-v1)
- mTLS for edge-to-control-plane streams

---

## Suggested PR split

1. **PR A:** SSE handler rewrite (long-lived stream + heartbeat + `410 Gone` + cursor events + connection limits + config) + snapshot compression + graceful shutdown + unit tests
2. **PR B:** Integration test suite + sync cursor tracking + lag endpoint + docs

---

## Verification

```bash
# Unit
cd control-plane && npm run test:unit

# Integration (needs Postgres + trust-engine for score seed)
# Terminal A: go run ./cmd/trust-engine -grpc-port 9091 -http-port 8086
# Terminal B:
cd control-plane && TRUST_ENGINE_ADDR=127.0.0.1:9091 npm run test:integration

# Manual smoke — SSE stream
curl -N -H 'Authorization: Bearer <apikey>' \
  -H 'Accept: text/event-stream' \
  'http://localhost:3000/v1/sync/events'
# Should receive retry: 5000, then : ping every 30s + poll-delivered events when scores change
# cursor events fire every poll cycle when high-water advances

# Bootstrap — new edge (no 410)
curl -N -H 'Authorization: Bearer <apikey>' \
  -H 'Accept: text/event-stream' \
  'http://localhost:3000/v1/sync/events'
# 200 stream even when sync_events is non-empty

# 410 Gone — backlog cap (not "future cursor")
# Configure low SYNC_SSE_MAX_INITIAL_BATCH or seed > cap events since Last-Event-ID

# 503 — connection limit
# Open SYNC_SSE_MAX_CONNECTIONS+1 concurrent SSE streams
# Last one should get 503
```
