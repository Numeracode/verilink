# Plan 7 — SSE edge sync

**Depends on:** Plans 1–6 (merged to `main`)  
**Target branch:** `feat/sse-edge-sync`  
**Goal:** Turn `GET /v1/sync/events` from a one-shot batch into a long-lived SSE stream with `: ping` heartbeats, `410 Gone` on pruned cursor, per-tenant `policy.replace` filtering, and non-durable cursor events so edges never receive a stale `Last-Event-ID`.

**Maps to:** productization design §4.5 steps 3–5, §13 step 11.

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
4. **Non-durable cursor events:** to advance `Last-Event-ID` across tenant-filtered gaps, the stream periodically sends `event: cursor\nid: <high_water_version>\ndata: {}\n\n`. This is SSE-only — no row in `sync_events`. Frequency: after every batch of durable events flushed, and during heartbeat if high-water advanced.
5. **Per-tenant filtering:** `score.upsert`, `score.delete`, `key.upsert`, `key.revoke` → all tenants. `policy.replace` → only the owning tenant. This is the existing repository filter.
6. **Event pruning:** not in scope for Plan 7. Events accumulate. Pruning (+ `410 Gone` enforcement) can be added in a follow-up once retention policy is set.
7. **No Redis** in Plan 7. The SSE stream polls Postgres. A Redis pub/sub notify layer for instant push can be added post-v1 when connection count warrants it.
8. **Polling interval for new events:** configurable, default **5 seconds**. The SSE handler polls `sync_events WHERE sync_version > $cursor` on a timer.
9. **Snapshot compression:** `GET /v1/sync/snapshot` should support gzip via `Accept-Encoding`. Express compression middleware is sufficient for Plan 7.
10. **Edge sync client (Go):** deferred to Plan 8 / step 12. Plan 7 delivers the control-plane streaming endpoint; the Go edge client consumes it in the next step.
11. **`sync_cursors` persistence:** the control-plane writes `last_cursor` per edge_node on disconnect (or periodically). This is informational for Plan 7 (monitor lag); not used for stream resume (the edge sends `Last-Event-ID`).

---

## Tasks

### Task 1: SSE long-lived stream handler

Rewrite `GET /v1/sync/events`:
- Read `Last-Event-ID` from header (per SSE spec) or `?last_event_id` query param (backwards compat); header wins.
- If cursor < `MIN(sync_version)` (or `sync_events` empty and cursor > 0): respond `410 Gone`.
- Set `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`, `X-Accel-Buffering: no`.
- Flush initial batch of events since cursor (tenant-filtered).
- After each batch: send non-durable cursor event at `high_water_version`.
- Enter poll loop: sleep `SYNC_SSE_POLL_INTERVAL_MS` (default 5000), query new events, flush, update cursor. Send `: ping\n\n` every `SYNC_SSE_HEARTBEAT_INTERVAL_MS` (default 30000) regardless of new events.
- On client disconnect (`req.on('close')`): update `sync_cursors.last_cursor` for the edge node (if known), clean up timers.
- **req.socket.setNoDelay(true)** for minimal latency.

### Task 2: Heartbeat timer

- Independent `setInterval` per SSE connection.
- Sends `: ping\n\n` (SSE comment, not a named event).
- Must survive even if no new events arrive.
- Clean up on disconnect.

### Task 3: Config additions

- `SYNC_SSE_POLL_INTERVAL_MS` (default 5000)
- `SYNC_SSE_HEARTBEAT_INTERVAL_MS` (default 30000)

### Task 4: Snapshot compression

- Add `compression` middleware to the Express app (or just the sync router).
- Verify `GET /v1/sync/snapshot` returns gzipped when client sends `Accept-Encoding: gzip`.

### Task 5: Integration test

- `control-plane/src/__tests__/integration/sse-sync.test.ts`
- Seed bootstrap + attestation + recompute → connect SSE → assert `score.upsert` events arrive.
- Assert `: ping` heartbeat within interval.
- Assert non-durable cursor event after batch.
- Assert `410 Gone` when cursor < min.
- Assert tenant filtering: tenant B does not receive tenant A `policy.replace`.
- Assert client disconnect cleans up (no leaked timers / intervals).

### Task 6: Sync cursor tracking

- On SSE connect: upsert `sync_cursors` with initial cursor.
- On disconnect: update `last_cursor`.
- Add `GET /v1/admin/sync/lag` (staff-only) returning per-edge lag = `high_water_version - last_cursor`.

### Task 7: Docs

- Update `HANDOVER.md` status: Plan 7 → in progress / complete.
- Update shared memory.

---

## Out of scope (next plans)

- **Plan 8 / step 12:** Go edge SSE client, atomic in-memory snapshot, bounded WAL, atomic disk snapshots
- **Plan 9 / step 13:** Dashboard
- Event pruning / retention policy
- Redis pub/sub for instant event push (post-v1)
- mTLS for edge-to-control-plane streams

---

## Suggested PR split

1. **PR A:** SSE handler rewrite (long-lived stream + heartbeat + `410 Gone` + cursor events + config) + snapshot compression + unit tests
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
# Should receive : ping every 30s + events when scores change

# 410 Gone
curl -H 'Authorization: Bearer <apikey>' \
  -H 'Last-Event-ID: 999999999' \
  'http://localhost:3000/v1/sync/events'
# Should return 410
```
