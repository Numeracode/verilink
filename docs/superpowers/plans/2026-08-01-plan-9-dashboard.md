# Plan 9 — Dashboard (provider + agent-builder + admin)

**Depends on:** Plans 1–8 (merged to `main`, including Plan 8 PR C #21)  
**Target branch:** `feat/dashboard` (split PRs below)  
**Goal:** Ship a Vite SPA at `dashboard/` served by the control plane: provider, agent-builder, and admin views over existing Postgres tables; wire missing read/write HTTP APIs; Stripe checkout/portal links (fixed-tier only).

**Maps to:** productization design §11 + §13 step 13.  
**Out of scope (design §14):** mobile dashboard, interactive graph explorer / path-summary cards, metered billing, Redis, SSO/SAML beyond Clerk OIDC.

---

## Context

| Exists | Missing |
|--------|---------|
| CP auth: Clerk OIDC + `vrl_` API keys | Dashboard SPA + OIDC login UX (PKCE) |
| Tables: `policies`, `api_keys`, `decision_*`, `network_scores` / history, `subscriptions`, `bootstrap_issuers`, `edge_nodes`, `sync_cursors` | HTTP routes for policy/API keys/aggregates/samples/score history/billing |
| `GET /v1/admin/sync/lag`, principals, attestations | Provider decision summary + sampled feed UI |
| Stripe dep + config stubs; webhook route commented | Billing domain: checkout, portal, webhook idempotency |
| Empty domain dirs: `policy/`, `apikey/`, `tenant/`, `edgenode/` | Implementations + dashboard clients |
| Design §11 view inventory | Scaffold under `dashboard/` (not yet in repo) |

---

## Locked decisions

1. **Layout:** new top-level `dashboard/` package (Vite + React + TypeScript). Do **not** nest under `control-plane/`. Control plane remains the only HTTP process that serves the built SPA in production.
2. **Serving:** production CP serves `dashboard/dist` as static files; SPA fallback for non-`/v1/*` and non-`/healthz` / non-webhook paths. Dev: Vite on its own port with `VITE_API_BASE_URL` pointing at CP. CORS already configurable via `CORS_ORIGIN`.
3. **Kit strategy — scaffold, do not clone Whimsy:** reuse **patterns** from Whimsy/Numera (Vite, Radix primitives, TanStack Query + Router, recharts, `pw-test` for Playwright). Do **not** copy Whimsy Firebase auth, file browser, or product pages. Fresh VeriLink routes/components/branding.
4. **Auth:** Clerk via **generic OIDC** (Authorization Code + PKCE) in the SPA; API calls use `Authorization: Bearer <access_token>`. Reuse existing CP `authenticateOidc` / membership resolution. No Clerk session SDK in the SPA. Platform staff = `users.is_staff` (existing). Tenant context: memberships table; UI requires an active tenant selection when the user has multiple.
5. **Three views (role gates):**
   - **Provider** — tenant members (prefer `tenant:admin` / `policy:admin` for writes). Trust summary (aggregates), sampled decision feed, agent list with `score` + `blacklisted` + `score_reason` (never infer blacklist from score==0), policy editor, API keys, edge sync status, billing portal link.
   - **Agent-builder** — tenant members: owned principals (`owner_tenant_id`), keys, assurance derived from keys, attestation feed (in/out), score history chart, issuer relationships (read-only), billing link.
   - **Admin** — platform staff only: tenant list, graph health summaries (node/edge counts, top issuers by outgoing volume — **read-only**, no path explorer), bootstrap registry **read + weight/de-emphasis edit** (full cold-start seed remains Plan 14), issuer verification queue (list issuers missing `verified_at`).
6. **API surface to add (control plane)** — all JSON, existing `AppError` / `defineHandler` patterns:
   - `GET/PUT /v1/policies/active` — active policy for caller tenant (`policy:admin` for PUT)
   - `GET/POST /v1/api-keys`, `DELETE /v1/api-keys/:id` — tenant-scoped; secret shown once on create
   - `GET /v1/decisions/aggregates?from=&to=&dimension=` — rollups from `decision_aggregates`
   - `GET /v1/decisions/samples?from=&to=&limit=` — sampled feed
   - `GET /v1/scores/:principalId/history` — `network_score_history`
   - `GET /v1/graph/summary` — counts + top issuers (staff or any authenticated tenant member; global graph is shared)
   - `GET /v1/edge-nodes` (+ sync lag fields) — tenant-scoped; staff may use existing admin lag
   - `POST /v1/billing/checkout-session`, `POST /v1/billing/portal-session`, `POST /webhooks/stripe` — fixed-tier only; webhook dedup via `stripe_webhook_events`
   - `GET /v1/tenants` (membership-scoped); staff: all tenants
   - Admin bootstrap: `GET/PATCH /v1/admin/bootstrap-issuers` (staff)
7. **Stripe:** fixed-tier subscriptions only (design). No live Stripe required for unit/integration: inject a `BillingTransport` stub in tests. Webhook signature verification mandatory when `STRIPE_WEBHOOK_SECRET` is set; refuse unsigned webhooks in production config.
8. **Staleness:** if latest successful VeriRank / score write is older than **1h**, provider + agent-builder show a non-blocking “scores may be stale” banner (design §9). Source: max(`network_scores.updated_at`) or recompute scheduler heartbeat if exposed; otherwise `MAX(created_at)` on recent `score.*` sync events.
9. **Testing:**
   - Dashboard: Vitest for components/hooks; Playwright golden path via **`pw-test`** (never raw parallel Playwright on this host)
   - CP: integration tests for new routes (authz, tenant isolation, Stripe stub)
   - Golden path (Playwright): OIDC test harness **or** API-key-backed UI mode for CI if Clerk is unavailable — prefer a **dev/test “API key session”** shim behind `VITE_AUTH_MODE=apikey` for CI only; production always OIDC
10. **CI:** add dashboard `typecheck` + `vitest` to Gate or a sibling job; Playwright e2e remains optional/manual until Clerk test creds exist (document). Do not block merge on live Clerk.
11. **Redis:** still productization backlog — no dashboard dependency on Redis.
12. **Migrations:** prefer **no new tables** in Plan 9; schema already has subscriptions, aggregates, samples, policies, keys. Only add a migration if a concrete query cannot be satisfied (must be justified in the implementing PR).

---

## Suggested PR split

1. **Docs PR (this):** Plan 9 locked decisions + HANDOVER pointer
2. **PR A — shell:** `dashboard/` Vite scaffold + TanStack Router routes + OIDC/API-key auth client + CP static serve of `dashboard/dist` + health/smoke
3. **PR B — provider data path:** CP read APIs (aggregates, samples, scores history, graph summary, edge-nodes, policies GET) + provider view charts/feed/agent list
4. **PR C — control plane writes + agent-builder:** policy PUT, API key CRUD, agent-builder view (principals/attestations/history)
5. **PR D — billing + admin:** Stripe checkout/portal/webhook, admin tenants/bootstrap/graph health/issuer queue

---

## Tasks (implementation checklist)

### Task 1: Dashboard scaffold
- `dashboard/package.json`, Vite, TS, Radix, TanStack Query/Router, recharts
- Layout shells for provider / agent-builder / admin
- Env: `VITE_API_BASE_URL`, `VITE_CLERK_*` / OIDC client id, `VITE_AUTH_MODE`

### Task 2: CP static hosting
- Serve SPA after API routes; never shadow `/v1` or `/webhooks/stripe`
- Document build order: `dashboard` build → CP start (or compose)

### Task 3: Policy + API key domains
- Fill `domains/policy` + `domains/apikey` + routes; sync `policy.replace` on active policy change (existing sync allocator)

### Task 4: Decision + score read APIs
- Aggregates/samples queries with tenant isolation; history by principal
- Surface `blacklisted` + `score_reason` on agent list payloads

### Task 5: Provider + agent-builder UI
- recharts summaries; sampled feed table; policy form; keys UI

### Task 6: Billing
- Port Whimsy-style checkout/portal/webhook patterns; persist `subscriptions` + webhook IDs

### Task 7: Admin UI
- Tenants, graph summary, bootstrap issuer editor (weights / de-emphasis reason / approved_by), issuer verification queue

### Task 8: Tests + HANDOVER
- Vitest + CP integration; update HANDOVER + shared memory when each PR lands

---

## Verification

```bash
# Control plane
cd control-plane && npm test && npm run test:integration

# Dashboard
cd dashboard && npm run typecheck && npm test

# Optional e2e (serialized)
cd dashboard && npm run test:e2e   # must route through pw-test
```

---

## Known risks

- Clerk unavailable in CI → Decision 9 API-key auth mode for tests only
- Policy replace must emit `sync_events` or edges will serve stale policy
- Large `decision_aggregates` ranges need bounded `from`/`to` (default last 24h, max 31d)
- Stripe webhook raw-body ordering vs `express.json` (already noted in `app.ts`)
