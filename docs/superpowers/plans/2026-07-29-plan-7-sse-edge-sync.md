# Plan 7 — SSE edge sync

**Depends on:** Plans 1–6 (merged to `main`)  
**Target branch:** `feat/sse-edge-sync`  
**Goal:** Turn `GET /v1/sync/events` from a one-shot batch into a long-lived SSE stream with `: ping` heartbeats, `410 Gone` on pruned cursor, per-tenant `policy.replace` filtering, and non-durable cursor events so edges never receive a stale `Last-Event-ID`.

**Maps to:** productization design §4.5 steps 3–5, §13 step 11.

**Review revisions (2026-07-29):** cursor event frequency tightened to every poll cycle; snapshot compression scoped to non-SSE routes only with flush strategy; snapshot-consistent high-water for cursor events; connection limits and backpressure noted; graceful shutdown for SSE draining; sync_cursors write hardened; CI trust-engine requirement explicit.

---

## Review findings closure

All actionable comments from human review, CodeRabbit, and Qodo on PR #14 are locked below. Implementation must satisfy every row.

| Source | Finding | Locked where |
|--------|---------|--------------|
| Human | Cursor event frequency underspecified — should fire every poll cycle when high-water advances | Decision 4 (revised) |
| Human / Qodo | Snapshot compression middleware will buffer SSE if applied globally | Decision 9 (revised); Task 4 (revised) |
| Human | No connection limits or backpressure | Decision 12 (new) |
| Human | Integration test CI needs trust-engine sidecar | Decision 13 (new) |
| Human | sync_cursors disconnect write may be lossy | Decision 11 (revised); Task 6 (revised) |
| Qodo | Cursor jump skips events if high-water read not in same snapshot | Decision 14 (new); Task 1 (revised) |

---

## Context

Plan 6 landed the score writer that appends `score.upsert` / `score.delete` into `sync_events` inside the same transaction as score writes. The snapshot endpoint (`GET /v1/sync/snapshot`) already returns `highWaterVersion` from a repeatable-read image. But the `/v1/sync/events` route today reads events once, writes a single non-durable `cursor` event at the high-water mark, and closes — it is **not** a long-lived SSE stream.

What's missing:

| Exists | Missing |
|--------|---------|
| `sync_events` table with `sync_version` monotonic allocator | Long-lived SSE connection (`Connection: keep-alive`, `: ping` heartbeats) |
| `GET /v1/sync/events` one-shot batch | `Last-Event-ID` support + `410 Gone` when cursor pruned |
| Per-tenant filtering (`tenant_id IS NULL OR tenant_id = $2`) | Non-durable cursor events between tenant-filtered gaps |
| `sync_cursors` table (migration 005) | Cursor tracking per connected edge node |
| Edge verifier Go binary (Plan 3) | Go SSE client in edge + atomic snapshot swap |
| Snapshot endpoint with `high_water_version` | Compressed (gzip) snapshot response |

---

## Locked decisions

1. **SSE stream = long-lived HTTP connection** with `text/event-stream`. The edge opens `GET /v1/sync/events?last_event_id=<version>` with `Accept: text/event-stream`. New events are pushed as they are committed to `sync_events`.
2. **Heartbeats are SSE comment lines** (`: ping\n\n`), not durable rows. Interval: configurable, default **30 seconds**. The edge uses bytes-received-on-stream as the freshness signal.
3. **`410 Gone` on pruned cursor:** if `last_event_id` < `MIN(sync_version)` in `sync_events`, the control plane responds with HTTP 410 immediately. The edge must fetch a fresh full snapshot and resume.
4. **Non-durable cursor events (revised):** to advance `Last-Event-ID` across tenant-filtered gaps, the stream sends `event: cursor\nid: <high_water_version>\ndata: {}\n\n`. This is SSE-only — no row in `sync_events`. **Frequency: on every poll cycle where high-water has advanced since last emitted cursor** (not just during heartbeats). This keeps `Last-Event-ID` within one poll interval of the true high-water, regardless of whether durable events were tenant-visible.
5. **Per-tenant filtering:** `score.upsert`, `score.delete`, `key.upsert`, `key.revoke` → all tenants. `policy.replace` → only the owning tenant. This is the existing repository filter.
6. **Event pruning:** not in scope for Plan 7. Events accumulate. Pruning (+ `410 Gone` enforcement) can be added in a follow-up once retention policy is set.
7. **No Redis** in Plan 7. The SSE stream polls Postgres. A Redis pub/sub notify layer for instant push can be added post-v1 when connection count warrants it.
8. **Polling interval for new events:** configurable, default **5 seconds**. The SSE handler polls `sync_events WHERE sync_version > $cursor` on a timer.
9. **Snapshot compression (revised):** `GET /v1/sync/snapshot` supports gzip via `Accept-Encoding`. **Compression middleware must be scoped to the snapshot route only** — it must **not** wrap the SSE `/v1/sync/events` response. SSE responses must not be compressed (buffering breaks heartbeat freshness guarantees). For snapshot, use `compression({ flush: zlib.Z_SYNC_FLUSH })` so large snapshot payloads stream without excessive buffering.
10. **Edge sync client (Go):** deferred to Plan 8 / step 12. Plan 7 delivers the control-plane streaming endpoint; the Go edge client consumes it in the next step.
11. **`sync_cursors` persistence (revised):** the control-plane writes `last_cursor` per edge_node on disconnect (best-effort) **and** periodically during the connection (every 60 seconds or every 100 events, whichever comes first). The disconnect write uses `req.on('close')` with a try/catch — failures are logged as warnings, not thrown. Periodic writes prevent data loss from unclean disconnects. This is informational for Plan 7 (monitor lag); not used for stream resume (the edge sends `Last-Event-ID`).
12. **Connection limits and backpressure (new):**
    - Configurable max concurrent SSE connections per control-plane instance: `SYNC_SSE_MAX_CONNECTIONS` (default 100). New connections beyond this limit receive `503 Service Unavailable`.
    - Initial batch cap: if the backlog since `Last-Event-ID` exceeds `SYNC_SSE_MAX_INITIAL_BATCH` events (default 10000), respond `410 Gone` instead of streaming a huge batch that could OOM. The edge should fetch a fresh snapshot and resume.
    - Graceful shutdown: on SIGTERM/SIGINT, stop accepting new SSE connections, send a final `: shutdown\n\n` comment to all active connections, then close them with a configurable drain timeout (default 5 seconds). SSE cleanup must happen **before** the HTTP server close and pool.end().
    - Reconnection storm mitigation: edges should implement exponential backoff (documented in the SSE response via `retry:` field, default 5000ms). The control-plane sets `retry: <ms>\n` in the initial SSE preamble.
    - These are v1 safety rails. Redis pub/sub (post-v1) will change the scaling profile.
13. **CI trust-engine requirement (new):** Plan 7 integration tests seed scores via `recomputeNow`, which requires a live trust-engine. CI already starts trust-engine as a sidecar (Plan 6 PR B). Plan 7 integration tests reuse this CI setup — no mocking. The `TRUST_ENGINE_ADDR` env var is mandatory in CI for these tests.
14. **Snapshot-consistent high-water for cursor events (new):** each poll cycle must read both tenant-filtered events **and** high-water version from the **same query or snapshot**. Implementation: the poll query returns events; the high-water is `MAX(sync_version)` from the unfiltered `sync_events` table in the same `SELECT` (or a CTE). This prevents the race where a tenant-visible event commits between the event read and the high-water read and is skipped forever.

---

## Tasks

### Task 1: SSE long-lived stream handler

Rewrite `GET /v1/sync/events`:
- Check active SSE connection count; if >= `SYNC_SSE_MAX_CONNECTIONS`, respond `503`.
- Read `Last-Event-ID` from header (per SSE spec) or `?last_event_id` query param (backwards compat); header wins.
- If cursor < `MIN(sync_version)` (or `sync_events` empty and cursor > 0): respond `410 Gone`.
- If backlog > `SYNC_SSE_MAX_INITIAL_BATCH`: respond `410 Gone` (force snapshot refresh).
- Set `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`, `X-Accel-Buffering: no`.
- Write SSE preamble: `retry: <SYNC_SSE_POLL_INTERVAL_MS>\n\n`.
- Flush initial batch of events since cursor (tenant-filtered).
- After each batch: if high-water advanced, send non-durable cursor event. **High-water must come from the same query/snapshot as the event read (Decision 14).**
- Enter poll loop: sleep `SYNC_SSE_POLL_INTERVAL_MS` (default 5000), query new events + high-water atomically, flush events, send cursor event if high-water advanced (even with zero tenant-visible events). Send `: ping\n\n` every `SYNC_SSE_HEARTBEAT_INTERVAL_MS` (default 30000) regardless of new events.
- On client disconnect (`req.on('close')`): best-effort update `sync_cursors.last_cursor`, clean up all timers/intervals.
- **req.socket.setNoDelay(true)** for minimal latency.

### Task 2: Heartbeat timer

- Independent `setInterval` per SSE connection.
- Sends `: ping\n\n` (SSE comment, not a named event).
- Must survive even if no new events arrive.
- Clean up on disconnect.

### Task 3: Config additions

- `SYNC_SSE_POLL_INTERVAL_MS` (default 5000)
- `SYNC_SSE_HEARTBEAT_INTERVAL_MS` (default 30000)
- `SYNC_SSE_MAX_CONNECTIONS` (default 100)
- `SYNC_SSE_MAX_INITIAL_BATCH` (default 10000)

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
- Assert `410 Gone` when cursor < min.
- Assert `410 Gone` when backlog > max initial batch (seed enough events or lower config).
- Assert `503` when max connections exceeded.
- Assert tenant filtering: tenant B does not receive tenant A `policy.replace`.
- Assert client disconnect cleans up (no leaked timers / intervals).
- Assert graceful shutdown sends `: shutdown` and closes connections.

### Task 6: Sync cursor tracking (revised)

- On SSE connect: upsert `sync_cursors` with initial cursor.
- **Periodic persistence:** every 60 seconds or 100 events (whichever first), update `last_cursor` in a try/catch (failures logged, not thrown).
- On disconnect: best-effort update `last_cursor` with try/catch + warning log on failure.
- Add `GET /v1/admin/sync/lag` (staff-only) returning per-edge lag = `high_water_version - last_cursor`.

### Task 7: SSE connection lifecycle + graceful shutdown

- Track active SSE connections in a `Set` (or similar) on the server.
- On SIGTERM/SIGINT (in `index.ts` shutdown handler): iterate active SSE connections, write `: shutdown\n\n`, close after drain timeout. **This must happen before `server.close()` and `pool.end()`.**
- Expose active connection count for the 503 gate and for monitoring.

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
# Should receive retry: 5000, then : ping every 30s + events when scores change
# cursor events fire every poll cycle when high-water advances

# 410 Gone — pruned cursor
curl -H 'Authorization: Bearer <apikey>' \
  -H 'Last-Event-ID: 999999999' \
  'http://localhost:3000/v1/sync/events'
# Should return 410

# 503 — connection limit
# Open SYNC_SSE_MAX_CONNECTIONS+1 concurrent SSE streams
# Last one should get 503
```
