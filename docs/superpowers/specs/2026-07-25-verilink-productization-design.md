# VeriLink Productization Design

- **Status:** Draft v1 — review rounds in progress
- **Date:** 2026-07-25
- **Owner:** Sanjay
- **Repo:** `/srv/storage/repo/VeriLink/`
- **Related specs:** [`docs/specs/attestation_schema.md`](../../specs/attestation_schema.md), [`docs/specs/fingerprinting.md`](../../specs/fingerprinting.md), [`docs/specs/trust_graph.md`](../../specs/trust_graph.md)
- **Related roadmap:** [`ROADMAP.yml`](../../ROADMAP.yml) (MVP Phase 0 — all six tasks complete)

---

## 1. Executive summary

VeriLink today is a working but internal Go toolkit for AI-agent identity and attestation: it fingerprints inbound requests, verifies signed JWS behavioral attestations, computes transitive trust scores via the VeriRank algorithm, and exposes an edge verifier reverse proxy that allows or denies traffic before it reaches an application. All six MVP roadmap tasks are complete and tests pass, but the system is in-memory only, ships no hosted surface, publishes no npm package, and the README itself states it is "not a hosted SaaS."

This document specifies how VeriLink becomes a proper product: an **open-source toolkit plus a hosted trust network** (the Tailscale/Snyk model), positioned as the trust protocol for the agentic economy. Any API provider can run the edge verifier in front of their API and make a deterministic allow/deny decision about any autonomous agent in under one millisecond, without prior registration with that provider. Any agent builder can register their agent's fingerprint, receive attestations from counterparties who observe the agent's behavior, and carry a portable reputation across the network.

The two-sided network is cold-started by VeriLink itself: a curated root-of-truth registry of known agent frameworks and public API providers, seeded at launch, de-emphasized as organic attestations take over.

The product is a single monorepo with four deployable surfaces: a Rust edge verifier (rewritten from Go for the sub-millisecond budget), a TypeScript control plane and dashboard (reusing the hardened Numera/Whimsy stack — Express, Postgres, Redis, Radix, TanStack), a Go trust-engine gRPC service wrapping the existing verified algorithms, and the existing Go plus Node clients (npm-published). Whimsy is the first reference customer: its `api/src/shared/verilink.js` module already integrates with the attestation API and becomes the first seeded issuer.

---

## 2. Product positioning

### 2.1 What VeriLink is, post-productization

The trust protocol for the agentic economy. An open-source toolkit and a hosted trust network that together let any API provider make a deterministic trust decision about any autonomous agent in under one millisecond, without prior cooperation or registration with that provider.

### 2.2 The two-sided network

**Providers** are API platforms that receive agentic traffic. They run the Rust edge verifier in front of their API. The verifier fingerprints inbound requests, queries a local cache of trust scores synced from the hosted graph, and allows, denies, or challenges the request before it reaches the application. Providers pay for the hosted control plane: trust scores, dashboards, the sync API, policy configuration, and audit.

**Agent builders** are anyone shipping an autonomous agent. They register their agent's fingerprint with VeriLink, receive attestations from counterparties who observe the agent's behavior, and carry a portable reputation across the network. A free tier seeds this side of the network; a paid tier provides verified or featured reputation, higher attestation volume, and an SLA.

### 2.3 The cold-start wedge

A two-sided trust network dies if it launches empty. VeriLink seeds a root-of-truth registry at launch: a curated set of known agent frameworks (for example LangChain, CrewAI, AutoGen agents with published fingerprints), public API providers acting as issuers, and VeriLink's own bootstrap issuer. Providers see a non-empty graph on day one. Agent builders see value in registering because providers are already querying the graph. VeriLink's bootstrap issuer is gradually de-emphasized as organic attestations take over.

### 2.4 The moat

The trust graph data accrues only to the hosted network. The open-source toolkit is fully auditable — the trust math is transparent, which is critical for a security product — but the live network of attestations and the computed trust scores are the asset competitors cannot copy by running the same code. Network effects compound: every new issuer and attestation strengthens the graph for every provider.

### 2.5 Tagline wedge

"Trust decisions for agents you've never met."

---

## 3. Decisions locked during brainstorming

| Decision | Choice | Rationale |
|---|---|---|
| Productization model | Open-source toolkit + hosted SaaS | Tailscale/Snyk model; fits existing OSS foundation and trust-graph network effects |
| Primary buyer | Two-sided network | Long-term moat; both providers and agent builders interact with the hosted graph |
| v1 scope | Full control plane + hardened OSS | Both sides onboard from day one; truest to the two-sided vision |
| Edge stack | Rust | Commits to the sub-millisecond performance story the roadmap demands |
| Control-plane stack | TypeScript (reusing Numera/Whimsy) | Maximal reuse of hardened auth, RBAC, audit, Redis, Postgres, frontend kit |
| Trust-core algorithms | Stay Go, exposed via gRPC | Avoids a third reimplementation of verified trust math; Rust edge reimplements for perf with FFI parity tests |
| Graph cold-start | VeriLink-seeded root of trust | Empty graphs kill adoption; VeriLink bootstraps, then de-emphasizes as organic volume grows |
| Repo structure | Single monorepo | Small team; one CI, one version, atomic releases; can split later if contributor complexity demands |

---

## 4. Architecture

### 4.1 Monorepo layout

```
verilink/
├── pkg/                    # Go — shared trust core (existing, hardened)
│   ├── fingerprint/        # JA4 + header canonicalization + key hash (existing)
│   ├── attestation/        # JWS issue/verify, schema (existing)
│   ├── trust/              # VeriRank algorithm (existing) + graph store interface
│   └── verifier/           # trust store interface (existing)
├── cmd/                    # Go binaries
│   ├── trust-engine/       # NEW: gRPC server exposing pkg/* to TS control plane + Rust edge
│   ├── attestation-service/# deprecated after TS control plane ships; kept one release as fallback
│   ├── edge-verifier/      # deprecated after edge-rs ships; kept one release as fallback
│   └── keygen/             # kept
├── edge-rs/                # Rust — NEW: sub-millisecond edge verifier rewrite
│   ├── fingerprint/        # port of pkg/fingerprint hot path to Rust
│   ├── proxy/              # reverse proxy + allow/deny middleware
│   ├── cache/              # local trust-score cache (synced from control plane)
│   └── ffi/                # cbindgen bindings for Go parity testing
├── control-plane/          # TS — NEW, ports Whimsy api/ patterns
│   ├── src/
│   │   ├── db/             # port of whimsy api/src/db (client, migrate, transaction)
│   │   ├── middleware/     # port: auth (API key + HMAC), rateLimit, audit
│   │   ├── authz/          # port: RBAC (actions, policies, grants, decision)
│   │   ├── shared/         # port: logger, redis, apiKeyRequestActivity, encryption, openapi
│   │   ├── domains/
│   │   │   ├── tenant/     # multi-tenant onboarding, quotas
│   │   │   ├── registry/   # agent + issuer registry (replaces in-memory maps)
│   │   │   ├── graph/      # attestation store; calls trust-engine gRPC for VeriRank
│   │   │   ├── sync/       # trust-score sync API for edge-rs (SSE + pull)
│   │   │   ├── bootstrap/  # VeriLink root-of-truth seeder
│   │   │   └── policy/     # per-tenant thresholds
│   │   └── index.js
│   ├── migrations/         # SQL migrations (whimsy-style numbered dirs)
│   └── package.json
├── dashboard/              # TS — Vite + Radix + TanStack (Numera/Whimsy kit)
│   ├── src/
│   ├── package.json
│   ├── components.json
│   └── tailwind.config.ts
├── client/
│   ├── go/                 # existing Go client (unchanged)
│   ├── node/               # existing Node client; add npm publish + TypeScript types
│   └── rust/               # NEW: Rust client for edge-rs <-> control-plane
├── deploy/
│   ├── docker/             # Dockerfile.edge, Dockerfile.control-plane, Dockerfile.trust-engine,
│   │                       # docker-compose.self-host.yml
│   └── helm/               # Helm chart (edge DaemonSet + control-plane Deployment +
│                           # trust-engine Deployment + Postgres + Redis + HPA)
├── docs/                   # docs site (mkdocs or docusaurus) — schema refs, quickstarts,
│   │                       # integration guides, self-host guide
│   └── superpowers/specs/  # this document
└── scripts/
    ├── dev-up.sh           # local dev orchestration
    └── parity-check.sh     # cross-language fingerprint parity CI job
```

### 4.2 Deployable components

| Component | Language | Port | Role |
|---|---|---|---|
| `edge-rs` | Rust | 8080 (data), 9090 (admin) | Reverse proxy. Fingerprints inbound requests, looks up local trust cache, allow/deny/challenge, proxy to backend. Pulls score snapshot from control-plane sync API. |
| `control-plane` | TypeScript (Express) | 443 REST + gRPC | Multi-tenant API: agent and issuer registry, attestation submission and verification, trust-score sync endpoint, policy configuration, API keys, onboarding, billing webhooks. |
| `trust-engine` | Go (gRPC) | 9091 | Stateless VeriRank runner + attestation JWS verify + fingerprint parity check. Called by the control plane. Scales horizontally. |
| `dashboard` | TypeScript (Vite SPA) | served by control-plane | Provider and agent-builder views: agents, attestations, trust graph visualization, policy editor, API keys, billing. |

Supporting infrastructure: Postgres (durable state), Redis (control-plane sync buffer and rate-limit counters). The edge runs local-memory only — no Redis on the edge — to hold the sub-millisecond lookup budget.

### 4.3 Data flow

**Attestation ingest:**

1. A counterparty observes an agent's behavior.
2. The counterparty's service calls `control-plane POST /v1/attestations/submit` with a signed JWS token (via the Go, Node, or Rust client).
3. The control plane verifies the signature by calling `trust-engine.VerifyAttestation` over gRPC, checking the issuer against the `issuers` registry.
4. On success, the attestation is stored in Postgres and a `RunVeriRank` job is enqueued for that tenant (debounced — one run per tenant per minute, or immediately if no run is in flight).

**Score computation:**

1. The control plane's `graph` domain loads the tenant's attestations from Postgres.
2. It calls `trust-engine.RunVeriRank` over gRPC with the attestation set.
3. The trust engine runs the VeriRank BFS algorithm (max four hops, distance decay 0.8^d, time decay e^(-λt), negative-override blacklist) and returns a score table.
4. The control plane writes results to the `trust_scores` table (durable) and to Redis (the sync buffer), and updates the tenant's `sync_cursors`.

**Edge sync:**

1. `edge-rs` boots with a tenant API key and an mTLS client certificate.
2. It calls `control-plane GET /v1/sync/scores?cursor=<last>` (SSE or long-poll).
3. The control plane reads the tenant's score table from Redis and streams the snapshot.
4. `edge-rs` loads the snapshot into an in-process LRU cache and persists a copy to local disk as the last-good snapshot.
5. The connection stays open; the control plane pushes deltas as `RunVeriRank` completes. Cache stays warm without polling.

**Allow/deny decision:**

1. An inbound agent request hits `edge-rs` on port 8080.
2. `edge-rs` computes the fingerprint in Rust (JA4 header, protocol, User-Agent, key hash).
3. It looks up the fingerprint in the local cache (sub-millisecond).
4. Per the tenant's policy: `allow` (proxy to backend, add `X-Verilink-Status: Allowed`), `deny` (403, `X-Verilink-Status: Denied`), or `challenge` (return a challenge token the agent must resubmit).
5. The decision, fingerprint, and request metadata are streamed back to the control plane as telemetry and recorded in `audit_log`.

### 4.4 Trust-engine gRPC contract

```proto
service TrustEngine {
  rpc RunVeriRank(RunRequest) returns (ScoreTable);
  rpc VerifyAttestation(JwsToken) returns (VerifyResult);
  rpc Fingerprint(FingerprintRequest) returns (Fingerprint);
}

message RunRequest {
  string tenant_id = 1;
  repeated Attestation attestations = 2;
  repeated Issuer issuers = 3;
  repeated string bootstrap_dids = 4;
}
message ScoreTable { repeated ScoreRow rows = 1; }
message ScoreRow {
  string agent_id = 1;
  int32 score = 2;
  double confidence = 3;
  int32 hop_count = 4;
  bool blacklisted = 5;
}
message JwsToken { string token = 1; }
message VerifyResult {
  bool valid = 1;
  string issuer_did = 2;
  string agent_id = 3;
  Payload payload = 4;
  string error = 5;
}
message FingerprintRequest {
  string ja4 = 1;
  string protocol = 2;
  string user_agent = 3;
  string key_hash = 4;
}
message Fingerprint { string sha256 = 1; }
```

The control plane writes the returned `ScoreTable` to Redis after each `RunVeriRank` call. `edge-rs` pulls from the sync API (which reads Redis) and never talks to the trust engine directly. This keeps the trust engine stateless and horizontally scalable, and keeps the edge's dependency surface minimal (one HTTP connection to the control plane).

### 4.5 Reused vs. new (delta from Whimsy)

| Whimsy module | VeriLink use | Effort |
|---|---|---|
| `api/src/db/{client,migrate,transaction}.js` | Direct port, swap schema | tiny |
| `api/src/middleware/auth.js` (API key extraction, HMAC-SHA256 hashing, legacy migration path) | Direct port, change `whm_` prefix to `vrl_`, swap Firebase auth for email/OIDC | small |
| `api/src/middleware/{rateLimit,audit}.js` | Direct port | tiny |
| `api/src/authz/` (RBAC: actions, policies, grants, decision, restrictions) | Direct port, define VeriLink resources (`agent`, `issuer`, `attestation`, `policy`, `tenant`) | small-medium |
| `api/src/shared/{logger,redis,apiKeyRequestActivity,encryption,openapi}.js` | Direct port | tiny |
| `app/` Vite + Radix + TanStack + shadcn kit | Fork as `dashboard/` scaffold, strip Whimsy features, add VeriLink views | medium |

### 4.6 What stays Go

The trust-core algorithms stay in Go as `pkg/*` because they are correct, tested, and complete. Reimplementing VeriRank, the JWS attestation codec, and the fingerprint logic in TypeScript would risk divergence and burn weeks for no benefit. Instead, a thin Go gRPC server (`cmd/trust-engine`, estimated ~200 lines of wrapper code) exposes the existing packages to the TypeScript control plane and the Rust edge. The Rust edge reimplements the fingerprint hot path for performance, with FFI parity tests proving the two implementations agree.

### 4.7 Whimsy as first reference customer

Whimsy's existing `api/src/shared/verilink.js` module already integrates with the VeriLink attestation API. It submits behavioral attestations about user remotes (encryption status, transfer success) and queries trust scores to enrich its encryption-status UI. Post-productization, this module points at the hosted control plane instead of `localhost:8082`, and Whimsy becomes the first reference customer and the first seeded issuer in the root-of-truth registry. The existing `vli: { type, facts, trust_level_delta }` payload format, already in production at Whimsy, becomes the de-facto v1 schema — no breaking change for the existing integration.

---

## 5. Data model

Postgres, row-level tenant isolation via `tenant_id` on every tenant-scoped table, Whimsy-style numbered SQL migrations.

### 5.1 Schema

```sql
-- Tenants (one per organization: a provider or an agent-builder org)
tenants (
  id           uuid pk,
  slug         text unique not null,
  name         text not null,
  plan         text not null default 'free',  -- free | pro | enterprise
  status       text not null default 'active',
  created_at   timestamptz not null default now()
);

-- Dashboard login users (NOT agents — agents are fingerprinted, not logged in)
users (
  id           uuid pk,
  tenant_id    uuid not null references tenants(id),
  email        citext not null,
  role         text not null default 'member',  -- owner | admin | member
  oidc_sub     text,
  created_at   timestamptz not null default now(),
  unique (tenant_id, email)
);

-- API keys — ports Whimsy middleware/auth.js (HMAC-SHA256)
api_keys (
  id              uuid pk,
  tenant_id       uuid not null references tenants(id),
  key_prefix      text not null,           -- first 12 chars, shown in UI
  key_hash_hmac   text not null,           -- HMAC-SHA256 keyed by API_KEY_HMAC_SECRET
  key_hash_legacy text,                    -- opportunistic migration from old SHA-256
  scopes          text[] not null,         -- attest:write | attest:read | sync:read | policy:admin | tenant:admin | billing:read
  last_used_at    timestamptz,
  created_at      timestamptz not null default now(),
  revoked_at      timestamptz
);

-- Issuers: entities that sign attestations (counterparties)
issuers (
  id              uuid pk,
  tenant_id       uuid not null references tenants(id),
  did             text not null,           -- did:key:<...>
  name            text not null,
  public_key_jwk  jsonb not null,
  trust_weight    numeric(3,2) default 1.0,-- 0.00..1.00 multiplier on this issuer's attestations
  is_bootstrap   boolean default false,    -- true for VeriLink-seeded root-of-truth
  verified_at     timestamptz,
  created_at      timestamptz not null default now(),
  unique (tenant_id, did)
);

-- Agents: registered autonomous agents
agents (
  id              uuid pk,
  tenant_id       uuid not null references tenants(id),
  fingerprint     text not null,           -- sha256 hex
  name            text,
  owner_did       text,
  metadata        jsonb default '{}',
  first_seen_at   timestamptz not null default now(),
  last_seen_at    timestamptz not null default now(),
  status          text not null default 'active',  -- active | revoked
  unique (tenant_id, fingerprint)
);

-- Attestations: signed behavioral reports (JWS)
attestations (
  id              uuid pk,
  tenant_id       uuid not null references tenants(id),
  issuer_id       uuid not null references issuers(id),
  agent_id        uuid not null references agents(id),
  jws_token       text not null,
  payload         jsonb not null,          -- full decoded claims
  facts           jsonb not null,          -- the vli.facts object
  trust_delta     integer not null,        -- the vli.trust_level_delta
  attestation_type text not null,          -- transaction_summary | kyb | security_audit | negative_incident
  jti             text,                    -- JWT ID for dedup
  issued_at       timestamptz not null,    -- from iat
  expires_at      timestamptz,             -- from exp
  sig_verified    boolean not null default true,
  received_at     timestamptz not null default now(),
  unique (tenant_id, jti)
);

-- Trust scores: materialized VeriRank output
trust_scores (
  agent_id        uuid not null references agents(id),
  tenant_id       uuid not null references tenants(id),
  score           integer not null,        -- 0..100
  confidence      numeric(3,2) not null,   -- 0.00..1.00
  hop_count       integer not null,
  blacklisted     boolean not null default false,
  computed_at     timestamptz not null default now(),
  primary key (agent_id, tenant_id)
);

-- Policies: per-tenant allow/deny config
policies (
  id              uuid pk,
  tenant_id       uuid not null references tenants(id),
  name            text not null,
  threshold       integer not null default 50,  -- 0..100; below = deny
  action          text not null default 'deny', -- allow | deny | challenge
  fingerprint_rules jsonb default '{}',   -- allow/deny by fingerprint pattern
  issuer_weights  jsonb default '{}',     -- per-issuer trust_weight overrides
  created_at      timestamptz not null default now()
);

-- Sync cursors: edge-rs pull-based sync state
sync_cursors (
  tenant_id       uuid not null references tenants(id),
  edge_node_id    text not null,
  last_cursor     bigint not null default 0,
  last_sync_at    timestamptz,
  snapshot_hash   text,
  primary key (tenant_id, edge_node_id)
);

-- Audit log — ports Whimsy shared/audit + apiKeyRequestActivity
audit_log (
  id              bigserial pk,
  tenant_id       uuid not null references tenants(id),
  actor_type      text not null,           -- user | api_key | edge_node | system
  actor_id        text,
  action          text not null,           -- attestation.submit | policy.update | edge.decide ...
  resource        text not null,
  resource_id     text,
  metadata        jsonb default '{}',
  ip              text,
  user_agent      text,
  created_at      timestamptz not null default now()
);

-- Bootstrap registry: VeriLink-seeded root of trust (cold start)
bootstrap_registry (
  did             text pk,
  name            text not null,
  kind            text not null,           -- agent | issuer
  public_key_jwk  jsonb,
  seed_score      integer not null,        -- 0..100 starting score
  seeded_at       timestamptz not null default now(),
  de_emphasized_at timestamptz             -- set when organic volume replaces this seed
);
```

### 5.2 Tenant isolation

Every tenant-scoped table carries `tenant_id`. Every query goes through the ported `authz/` layer — no raw SQL in route handlers. A `restrictions.js`-style filter injects `WHERE tenant_id = $1` automatically based on the request's authenticated tenant. Cross-tenant reads are impossible without an explicit staff-admin context.

### 5.3 Multi-tenancy model

Row-level isolation with a shared schema, not schema-per-tenant. Rationale: the OSS self-hosted deployment runs the same code with a single tenant, and row-level isolation means self-host users don't carry the complexity of schema management. Enterprise tenants who need physical isolation can run their own self-hosted deployment (the same code, the same Helm chart). This keeps one code path.

---

## 6. Security

| Concern | Measure |
|---|---|
| **Signature verification** | Ed25519 (EdDSA) — already in `pkg/attestation`. The trust engine verifies every JWS against `issuers.public_key_jwk`. Unknown issuer: reject and audit. |
| **API key storage** | Port Whimsy's HMAC-SHA256 scheme verbatim. Keys hashed with `API_KEY_HMAC_SECRET` (at least 16 chars). `key_hash_legacy` column for opportunistic migration from old SHA-256 rows. Raw keys never persisted. |
| **API key format** | `vrl_<64hex>`. Regex `/^vrl_[A-Za-z0-9_-]{32,128}$/`. Extraction via `Authorization: Bearer` or `X-API-Key` (same logic as Whimsy's tightened parser). |
| **Tenant isolation** | Row-level `tenant_id` on every scoped table. Every query goes through the ported `authz/` layer. A `restrictions.js`-style filter injects `WHERE tenant_id = $1` automatically. |
| **RBAC scopes** | `attest:write`, `attest:read`, `sync:read`, `policy:admin`, `tenant:admin`, `billing:read`. API keys carry scopes; dashboard users carry roles mapped to scopes via `authz/decision.js`. |
| **Rate limiting** | Port `middleware/rateLimit.js`. Per-tenant quotas by plan: free (100 attestations/day, 1 sync/min), pro (10k/day, 10 sync/min), enterprise (custom). Edge sync exempted from request rate limits (it's a long-poll connection). |
| **Edge to control-plane auth** | mTLS for the sync API plus a tenant API key. Edge node client certificate issued at onboarding, rotatable. |
| **Secrets** | Ed25519 private keys (issuer signing) live in a credential manager, never in env at rest. Port Whimsy's `shared/encryption.js` for envelope encryption of key material in Postgres. |
| **Audit** | Every state-changing API call and every edge allow/deny decision is written to `audit_log` via the ported `apiKeyRequestActivity.js` pattern. Retained 90 days on pro, 1 year on enterprise. |
| **Bootstrap registry protection** | Only `tenant:admin` on the VeriLink staff tenant can edit `bootstrap_registry`. Bootstrap issuers carry `is_bootstrap=true` and are visually distinct in the graph so providers can choose to weight them down. |
| **Replay protection** | Attestations carry `iat`/`exp` (already in the JWS schema). The trust engine rejects expired or future-dated tokens. `jti` is added to the schema for dedup. |
| **Fail-closed edge** | If the edge cache misses and the sync API is unreachable, the edge falls back to the last good snapshot on disk. If no snapshot exists, the edge returns 503 (fail closed — this is a security product). |

---

## 7. Error handling

Three layers, mirroring the Whimsy pattern.

### 7.1 Edge (`edge-rs`)

The data path never crashes. If the local cache misses or the sync API is unreachable, the edge falls back to the last good snapshot (persisted to disk on every successful sync) and emits a degraded-mode header `X-Verilink-Mode: degraded`. If no snapshot exists, the edge default-denies with `503` (fail closed). Sync failures retry with exponential backoff (1s to 30s cap) and surface to the control plane via the telemetry channel so the dashboard shows the edge node as `stale`.

### 7.2 Control plane (`control-plane` TS)

Whimsy-style structured errors via a ported `shared/errors/` module. Every error carries `code`, `httpStatus`, `message`, and `details`. Express error middleware normalizes. Attestation ingest is queue-backed (BullMQ, already a Whimsy dependency): a bad attestation rejects and records to `audit_log` without blocking the submit response. `RunVeriRank` failures retry three times then dead-letter; the tenant's `trust_scores` row stays at the last-good value with `computed_at` aging. The dashboard shows a staleness warning after one hour.

### 7.3 Trust engine (`trust-engine` Go)

Stateless gRPC server, no durable state of its own. Returns standard gRPC codes (`InvalidArgument`, `Unauthenticated`, `Internal`). `RunVeriRank` is idempotent — same input produces the same output — so the control plane can safely retry. Panics in a VeriRank run are caught at the handler boundary and returned as `Internal`; the goroutine survives.

### 7.4 Failure notifications

A dedicated `verilink-error-handler` n8n workflow wires an Error Trigger to Slack and email alerts. The control plane's `settings.errorWorkflow` points to it. Fires only for production executions, per the global AGENTS.md pattern.

---

## 8. Observability

| Signal | Source | Tool |
|---|---|---|
| **Metrics** | `edge-rs` (latency histogram, allow/deny counter, cache hit rate), `control-plane` (request rate, VeriRank duration, sync lag), `trust-engine` (gRPC duration, verify failures) | Prometheus scrape + Grafana. Reuse Whimsy's `shared/metrics.js` pattern for the TS side. |
| **Logs** | Structured JSON (port `shared/logger.js`). `edge-rs` uses the `tracing` crate. | Loki or CloudWatch. |
| **Traces** | OpenTelemetry across all three languages. Trace context propagated edge to control plane to trust engine. | OTLP collector to Tempo or Jaeger. |
| **Error tracking** | Port Whimsy's `@sentry/node` and `@sentry/react` setup. | Sentry. |
| **Internal dashboards** | VeriLink staff ops: graph size, VeriRank lag, edge node health, tenant signups. | Grafana. |
| **Tenant-facing dashboards** | Inside the product: providers see their own allow/deny traffic and sync status; builders see their agent's score history. | Product dashboard (recharts, already in the kit). |
| **Healthchecks** | `edge-rs /healthz` (cache age, last sync, backend reachability), `control-plane /healthz` (DB, Redis, trust-engine reachability), `trust-engine /healthz` (liveness). | Kubernetes liveness and readiness probes. |

---

## 9. Testing

| Layer | Approach |
|---|---|
| **Go core (`pkg/*`)** | Existing unit tests stay. Add property-based tests for VeriRank (decay invariants, monotonicity under positive attestations). gRPC contract tests for `cmd/trust-engine`. |
| **Rust edge (`edge-rs`)** | Unit tests for fingerprint parity vs. Go `pkg/fingerprint` (FFI parity tests — same input produces the same hash). Integration test: spin up a mock backend, send trusted and untrusted requests, assert allow/deny and headers. Latency benchmark: 10k req/s with sub-millisecond p99 overhead (CI gate, per `VR-002`). |
| **TS control plane** | Port Whimsy's Jest setup. Unit tests for ported modules (auth HMAC, RBAC decision, rate limit). Integration tests against a real Postgres and Redis (Whimsy's `jest.config.db.cjs` pattern). Contract tests against the gRPC trust engine using a test container. |
| **TS dashboard** | Vitest (unit) and Playwright (e2e) — both already in the Numera/Whimsy kit. Golden path: onboard a tenant, register an agent, submit an attestation, see the score, configure a policy. |
| **Cross-language parity** | CI job (`scripts/parity-check.sh`): generate a fingerprint from Go `pkg/fingerprint`, Rust `edge-rs/fingerprint`, and the Node client for the same request fixture. Assert all three match. Locks the contract across the stack. |
| **Load** | k6 or oha against `edge-rs` for the 10k req/s `VR-002` gate. Periodic nightly load test in staging. |
| **Security** | `semgrep` (already in the environment) on TS and Go. `cargo audit` on Rust. Secret scan pre-commit. |

---

## 10. Deployment

### 10.1 Artifacts (in `deploy/`)

- `docker/Dockerfile.edge` — Rust, multi-stage, distroless final image.
- `docker/Dockerfile.control-plane` — TypeScript, multi-stage.
- `docker/Dockerfile.trust-engine` — Go, multi-stage, distroless final image.
- `docker/docker-compose.self-host.yml` — all three services plus Postgres and Redis, for self-hosted OSS users.
- `helm/` — edge as a DaemonSet, control-plane and trust-engine as Deployments with HPAs, Postgres and Redis via upstream charts.

### 10.2 Local dev

- `scripts/dev-up.sh` — orchestrates all three services plus Postgres and Redis via Docker Compose, seeds the bootstrap registry, and prints the dashboard URL.

### 10.3 Hosted SaaS

The hosted control plane runs the same code as self-host, with a multi-tenant config flag (`VERILINK_MULTI_TENANT=true`) and a hosted Postgres, Redis, and trust-engine cluster. Edge nodes run on customer infrastructure and sync from the hosted control plane.

---

## 11. Dashboard

TypeScript Vite SPA, reusing the Numera/Whimsy kit (Radix UI, TanStack Router/Query, Tailwind, shadcn-style components, recharts, sonner, Sentry). Served by the control plane behind the same auth context.

### 11.1 Provider view

- Trust-score dashboard (recharts): allow/deny rates over time, top agents by traffic, top denied fingerprints.
- Live allow/deny feed (SSE from the control plane).
- Agent list with current scores and last-seen.
- Policy editor: threshold slider, issuer-weight overrides, fingerprint-pattern rules.
- API key management.
- Edge-node sync status (last sync, cursor lag, stale flag).
- Billing portal links.

### 11.2 Agent-builder view

- Registered agents list.
- Attestation feed: incoming (counterparties attesting to this agent) and outgoing (this builder attesting about others).
- Trust score over time (recharts).
- Issuer relationships.
- Embed snippet for a reputation badge (iframe or script tag for third-party sites).
- Billing portal links.

### 11.3 Admin (VeriLink staff) view

- Bootstrap registry editor (add/de-emphasize seed issuers and agents).
- Tenant list with plan and usage.
- Graph health: total nodes, total edges, VeriRank lag, bootstrap vs. organic ratio.
- De-emphasize bootstrap issuers as organic volume grows.

### 11.4 Trust graph visualization

The `@xyflow/react` dependency already in Whimsy's package.json provides the trust-graph visualization: nodes for agents and issuers, edges for attestations, color-coded by trust score, with bootstrap nodes visually distinct. Providers and builders can explore their subgraph.

---

## 12. Clients

| Client | Status | v1 action |
|---|---|---|
| `client/go` | Existing, working | Unchanged. Update to call the hosted control-plane URL. |
| `client/node` | Existing, vendored from source | Publish to npm as `@verilink/node` with TypeScript types. Update to call the hosted URL. |
| `client/rust` | New | Rust client for `edge-rs` to control-plane sync, and for Rust services that submit attestations. Publish to crates.io as `verilink`. |

All three clients target the same REST API surface (`/v1/attestations/submit`, `/v1/trust`, `/v1/sync/scores`). The Node client's existing `VeriLinkClient.fromEnv()` pattern is preserved.

---

## 13. v1 scope and sequencing

The v1 scope is the full control plane plus the hardened OSS toolkit, both sides onboarding from day one. Sequencing for implementation (detailed plan to follow in the writing-plans phase):

1. **Monorepo restructure + CI** — create the new directory layout, port CI for Go + TS + Rust, add the cross-language parity job.
2. **Control-plane TS foundation** — port Whimsy's `db/`, `middleware/`, `authz/`, `shared/` modules. Stand up Express with healthcheck. Run migrations against a fresh Postgres.
3. **Trust-engine gRPC** — wrap `pkg/*` in a gRPC server. Contract tests.
4. **Data model + domains** — implement the schema in Section 5, the `tenant`, `registry`, `graph`, `policy`, `bootstrap` domains.
5. **Attestation ingest end-to-end** — submit, verify via trust engine, store, enqueue VeriRank, write scores to Redis.
6. **Edge sync API** — `/v1/sync/scores` SSE/long-poll, reading from Redis.
7. **Rust edge verifier** — port fingerprint hot path, implement proxy + cache + sync client. FFI parity tests against Go. Latency benchmark gate.
8. **Dashboard** — fork the kit, build provider and agent-builder views, trust-graph viz.
9. **Bootstrap registry + cold-start seed** — curate the initial root-of-truth, seed script.
10. **Deployment artifacts** — Dockerfiles, Helm chart, docker-compose for self-host.
11. **Clients** — publish Node to npm, write Rust client, update Go client.
12. **Observability + security hardening** — Prometheus, Sentry, OpenTelemetry, semgrep, cargo audit.
13. **Whimsy integration migration** — point `shared/verilink.js` at the hosted control plane; Whimsy becomes the first seeded issuer.
14. **Docs site** — schema refs, quickstarts, integration guides (Envoy/Nginx/Kong), self-host guide.

---

## 14. Out of scope for v1

- Decentralized identity DID resolution beyond `did:key` (VeriLink's bootstrap registry substitutes for a DID network in v1).
- A public agent-reputation marketplace or featured listings (free vs. paid reputation tiers come post-v1).
- Support for non-HTTP protocols (gRPC, MQTT) at the edge — HTTP/HTTPS only in v1.
- A mobile dashboard.
- SSO/SAML for enterprise tenants (OIDC only in v1; SAML post-v1).
- A formal bug bounty program (post-launch).
- Multi-region hosted deployment (single region in v1; multi-region failover post-v1).

---

## 15. Open questions for review rounds

1. **OIDC provider choice** — Auth0, Clerk, or self-hosted (Keycloak)? Whimsy uses Firebase; we're swapping it. Recommendation: Clerk for developer ergonomics and billing-tier mapping, but open to Auth0 for enterprise SSO readiness.
2. **Billing provider** — Stripe Billing vs. Lemon Squeezy vs. defer to post-v1? Recommendation: Stripe Billing for the control-plane webhook integration maturity.
3. **Docs site generator** — MkDocs Material vs. Docusaurus? The dashboard is Vite/React; Docusaurus shares the stack. Recommendation: Docusaurus.
4. **Hosted region** — which cloud/region for the v1 hosted control plane? Depends on where Whimsy/Codero already run.
5. **Edge packaging beyond Docker/Helm** — a standalone static binary for non-K8s providers (systemd unit, bare-metal)? Recommendation: yes, ship a static `verilink-edge` binary alongside Docker, since many API providers run bare metal or simple VMs.
6. **Graph visualization scope** — full interactive graph in v1, or a read-only summary with the interactive explorer post-v1? Recommendation: read-only summary in v1, interactive explorer post-v1 (the @xyflow integration is non-trivial at scale).
7. **Reputation badge** — is the embeddable badge in scope for v1, or post-v1? Recommendation: post-v1; it's a marketing surface, not a trust surface, and v1 should focus on the provider allow/deny loop.

---

## 16. Success criteria for v1

- [ ] A provider can sign up, get an API key, run `edge-rs` in front of a backend, and receive allow/deny decisions on real agent traffic, end-to-end, in under 15 minutes from signup.
- [ ] The edge verifier holds the sub-millisecond p99 decision budget at 10k req/s (the `VR-002` gate), measured by the CI latency benchmark.
- [ ] An agent builder can register an agent fingerprint, receive an attestation from a counterparty, and see a non-zero trust score in the dashboard.
- [ ] The bootstrap registry is seeded and providers see a non-empty graph on first sync.
- [ ] Whimsy's `shared/verilink.js` points at the hosted control plane and its attestations appear in the graph.
- [ ] Self-hosted deployment via `docker-compose.self-host.yml` works with no manual SQL.
- [ ] The Node client is published to npm; the Rust client to crates.io.
- [ ] Cross-language fingerprint parity test passes in CI (Go, Rust, Node agree).
- [ ] Audit log records every attestation submission and every edge allow/deny decision.
- [ ] All three services have healthchecks wired to Kubernetes probes in the Helm chart.