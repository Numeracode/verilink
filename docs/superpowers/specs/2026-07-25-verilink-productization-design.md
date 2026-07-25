# VeriLink Productization Design

- **Status:** Draft v2 — review round 1 findings incorporated
- **Date:** 2026-07-25 (v2: 2026-07-25)
- **Owner:** Sanjay
- **Repo:** `/srv/storage/repo/VeriLink/`
- **Related specs:** [`docs/specs/attestation_schema.md`](../../specs/attestation_schema.md), [`docs/specs/fingerprinting.md`](../../specs/fingerprinting.md), [`docs/specs/trust_graph.md`](../../specs/trust_graph.md)
- **Related roadmap:** [`ROADMAP.yml`](../../ROADMAP.yml) (MVP Phase 0 — all six tasks complete)

---

## Change log

- **v2:** Resolves round-1 blocking findings: global trust graph (B1), gRPC fingerprint contract (B2), engine output contract (B3); major findings on Rust scope (M1), decision telemetry (M2), unknown-fingerprint path (M3), Sybil resistance (M4), JA4/TLS termination (M5), jti dedup (M6); minor schema corrections; locks all seven Section 15 questions; corrects the n8n error-notification misattribution; adds abuse controls (Round-1 finding 6), identity assurance levels (finding 2), edge sync contract (finding 5), and the global-vs-tenant partition.

---

## 1. Executive summary

VeriLink today is a working but internal Go toolkit for AI-agent identity and attestation: it fingerprints inbound requests, verifies signed JWS behavioral attestations, computes transitive trust scores via the VeriRank algorithm, and exposes an edge verifier reverse proxy that allows or denies traffic before it reaches an application. All six MVP roadmap tasks are complete and tests pass, but the system is in-memory only, ships no hosted surface, publishes no npm package, and the README itself states it is "not a hosted SaaS."

This document specifies how VeriLink becomes a proper product: an **open-source toolkit plus a hosted trust network** (the Tailscale/Snyk model), positioned as the trust protocol for the agentic economy. Any API provider can run the edge verifier in front of their API and make a deterministic allow/deny decision about any autonomous agent in under one millisecond, without prior registration with that provider. Any agent builder can register their agent's cryptographic identity with VeriLink, receive attestations from counterparties who observe the agent's behavior, and carry a portable reputation across the network.

The two-sided network is cold-started by VeriLink itself: a curated root-of-truth registry of known agent frameworks and public API providers, seeded at launch, de-emphasized as organic attestations take over.

The product is a single monorepo with four deployable surfaces: a Go edge verifier (v1) with a Rust edge rewrite deferred to post-v1 behind a parity harness, a TypeScript control plane and dashboard (reusing the hardened Numera/Whimsy stack — Express, Postgres, Redis, Radix, TanStack), a Go trust-engine gRPC service wrapping the existing verified algorithms, and the existing Go plus Node clients (npm-published). Whimsy is the first reference customer: its `api/src/shared/verilink.js` module already integrates with the attestation API and becomes the first seeded issuer.

The trust graph is **global**, not tenant-scoped. Agents, issuers, attestations, and canonical network scores are shared across the network. Tenants are a billing, ownership, API-key, and policy boundary — not a visibility boundary. One network-wide VeriRank run produces canonical scores; per-tenant thresholds and actions are applied as a policy-layer overlay at sync and decision time.

---

## 2. Product positioning

### 2.1 What VeriLink is, post-productization

The trust protocol for the agentic economy. An open-source toolkit and a hosted trust network that together let any API provider make a deterministic trust decision about any autonomous agent in under one millisecond, without prior cooperation or registration with that provider.

### 2.2 The two-sided network

**Providers** are API platforms that receive agentic traffic. They run the Go edge verifier in front of their API. The verifier fingerprints inbound requests, queries a local cache of trust scores synced from the hosted graph, and allows or denies the request before it reaches the application. Providers pay for the hosted control plane: trust scores, dashboards, the sync API, policy configuration, and audit.

**Agent builders** are anyone shipping an autonomous agent. They register their agent's **cryptographic identity** (a public key and DID) with VeriLink, receive attestations from counterparties who observe the agent's behavior, and carry a portable reputation across the network. A free tier seeds this side of the network; a paid tier provides verified reputation, higher attestation volume, and an SLA.

### 2.3 The cold-start wedge

A two-sided trust network dies if it launches empty. VeriLink seeds a root-of-truth registry at launch: a curated set of known agent frameworks (with their published public keys, not transport-derived fingerprints), public API providers acting as issuers, and VeriLink's own bootstrap issuer. Providers see a non-empty graph on day one. Agent builders see value in registering because providers are already querying the graph. VeriLink's bootstrap issuer is gradually de-emphasized as organic attestations take over.

### 2.4 The moat

The trust graph data accrues only to the hosted network. The open-source toolkit is fully auditable — the trust math is transparent, which is critical for a security product — but the live network of attestations and the computed trust scores are the asset competitors cannot copy by running the same code. Network effects compound: every new issuer and attestation strengthens the graph for every provider, because the graph is global.

### 2.5 Tagline wedge

"Trust decisions for agents you've never met."

---

## 3. Decisions locked during brainstorming and review

| Decision | Choice | Rationale |
|---|---|---|
| Productization model | Open-source toolkit + hosted SaaS | Tailscale/Snyk model; fits existing OSS foundation and trust-graph network effects |
| Primary buyer | Two-sided network | Long-term moat; both providers and agent builders interact with the hosted graph |
| v1 scope | Full control plane + hardened OSS | Both sides onboard from day one; truest to the two-sided vision |
| Trust graph partitioning | **Global graph; tenant-scoped policy/ownership only** | A tenant-scoped graph contradicts the portable-reputation moat. Canonical scores are network-wide; tenants apply thresholds as a policy overlay. |
| Agent canonical identity | **Public-key-backed DID; observed fingerprints are aliases** | Transport fingerprints (JA4/UA) are unstable across networks. The durable identity anchor is the agent's public key. |
| Edge stack (v1) | **Go (the existing, proven edge-verifier)** | ROADMAP `VR-002` is already marked complete: the Go proxy demonstrably meets 10k req/s at <1ms overhead. Rust is an implementation detail no customer buys; defer to post-v1 behind the parity harness. |
| Edge stack (post-v1) | Rust rewrite behind FFI parity harness | Performance headroom and memory footprint; only after the harness proves byte-identical fingerprints. |
| Control-plane stack | TypeScript (reusing Numera/Whimsy) | Maximal reuse of hardened auth, RBAC, audit, Redis, Postgres, frontend kit |
| Trust-core algorithms | Stay Go, exposed via gRPC | Avoids a third reimplementation of verified trust math |
| Graph cold-start | VeriLink-seeded root of trust | Empty graphs kill adoption; VeriLink bootstraps, then de-emphasizes |
| Repo structure | Single monorepo | Small team; one CI, one version, atomic releases |
| OIDC provider | **Clerk, implemented against generic OIDC (`openid-client`)** | Clerk for the hosted product; generic OIDC keeps self-host pluggable (Keycloak/Authentik) with one code path. Not the Clerk SDK. |
| Billing | **Stripe Billing, fixed-tier subscriptions in v1** | Standard B2B SaaS; reuse Whimsy/Numera patterns. Defer metered/usage billing. |
| Docs generator | **Docusaurus** | Aligns with React/TypeScript skills; versioned docs, MDX, OpenAPI rendering |
| Hosted region | **OCI Toronto (us-ashburn-1 or primary OCI region)** | Co-locates with Whimsy/Codero; eliminates cross-cloud egress; single-region accepted in Section 14 |
| Static edge binary | **Yes** | Linux x86_64 and aarch64, statically linked (CGO_ENABLED=0), systemd unit, sample config, checksums, SBOM, signed releases |
| Graph visualization (v1) | **Read-only summaries only** | Node/edge counts, top issuers, path summary cards. Interactive `@xyflow/react` explorer deferred to post-v1. |
| Reputation badge | **Post-v1** | Marketing surface, not a trust surface. v1 focuses on the provider allow/deny loop. |
| Challenge action | **Cut from v1** | No challenge format/lifecycle is designed. v1 is allow/deny only. |

---

## 4. Architecture

### 4.1 Monorepo layout

```
verilink/
├── pkg/                    # Go — shared trust core (existing, hardened)
│   ├── fingerprint/        # map-based header canonicalization + JA4 + key hash (existing)
│   ├── attestation/        # JWS issue/verify, Ed25519 (existing)
│   ├── trust/              # VeriRank algorithm (existing) + graph store interface
│   └── verifier/           # trust store interface (existing)
├── cmd/                    # Go binaries
│   ├── trust-engine/       # NEW: gRPC server exposing pkg/* to TS control plane
│   ├── edge-verifier/      # v1 edge (hardened from existing; TLS termination, RLS-safe cache)
│   ├── attestation-service/# deprecated after TS control plane ships
│   └── keygen/             # kept
├── edge-rs/                # Rust — DEFERRED to post-v1 (parity harness only in v1)
│   └── ffi/                # v1: cbindgen bindings for Go/Rust parity tests only
├── control-plane/          # TS — NEW, adapts Whimsy api/ patterns
│   ├── src/
│   │   ├── db/             # adapt whimsy api/src/db (client, migrate, transaction)
│   │   ├── middleware/     # adapt: auth (API key + HMAC), rateLimit, audit
│   │   ├── authz/          # adapt: RBAC (actions, policies, grants, decision)
│   │   ├── shared/         # adapt: logger, redis, apiKeyRequestActivity, encryption, openapi
│   │   ├── domains/
│   │   │   ├── tenant/     # multi-tenant onboarding, memberships, quotas
│   │   │   ├── registry/   # agent + issuer registry (global graph)
│   │   │   ├── graph/      # attestation store (global); calls trust-engine gRPC for VeriRank
│   │   │   ├── sync/       # trust-score sync API for edge (snapshot + SSE)
│   │   │   ├── bootstrap/  # VeriLink root-of-truth seeder
│   │   │   ├── policy/     # per-tenant thresholds and actions (overlay on global scores)
│   │   │   ├── billing/    # Stripe subscriptions, webhook dedup, entitlements
│   │   │   └── events/     # decision-event ingestion (separate from audit_log)
│   │   └── index.js
│   ├── migrations/         # SQL migrations (whimsy-style numbered dirs)
│   └── package.json
├── dashboard/              # TS — Vite + Radix + TanStack (Numera/Whimsy kit)
│   ├── src/
│   ├── package.json
│   ├── components.json
│   └── tailwind.config.ts
├── client/
│   ├── go/                 # existing Go client (updated for hosted URL)
│   ├── node/               # npm-published as @verilink/node, with TS types
│   └── rust/               # deferred with edge-rs; v1 ships Go + Node only
├── deploy/
│   ├── docker/             # Dockerfile.edge, Dockerfile.control-plane, Dockerfile.trust-engine,
│   │                       # docker-compose.self-host.yml
│   ├── helm/               # Helm chart (configurable topology — see 4.2)
│   └── systemd/            # verilink-edge.service unit template + sample config
├── docs/                   # Docusaurus site (schema refs, quickstarts, integration guides)
│   └── superpowers/specs/  # this document
└── scripts/
    ├── dev-up.sh           # local dev orchestration
    └── parity-check.sh     # cross-language fingerprint parity (Go vs Rust harness)
```

### 4.2 Deployable components

| Component | Language | Port | Role |
|---|---|---|---|
| `edge-verifier` (v1) | Go | 8080 (data), 9090 (admin) | Reverse proxy. Fingerprints inbound requests, looks up local trust cache, allow/deny, proxy to backend. Pulls score+policy snapshot from control-plane sync API. |
| `control-plane` | TypeScript (Express) | internal HTTP behind ingress; calls gRPC to trust-engine | Multi-tenant API: agent and issuer registry, attestation submission and verification, trust-score sync endpoint, policy configuration, API keys, onboarding, billing webhooks. Exposes REST to clients; the "443" is the ingress, not the process. |
| `trust-engine` | Go (gRPC) | 9091 | Stateless VeriRank runner + attestation JWS verify + fingerprint parity check. Called by the control plane. Scales horizontally. |
| `dashboard` | TypeScript (Vite SPA) | served by control-plane | Provider and agent-builder views: read-only graph summaries, agents, attestations, policy editor, API keys, billing. |

Supporting infrastructure: Postgres (durable state — the source of truth), Redis (sync buffer, rebuilt from Postgres after restart; rate-limit counters). The edge runs local-memory only — no Redis on the edge — to hold the sub-millisecond lookup budget.

**Edge deployment topology is configurable.** The Helm chart supports DaemonSet (side-by-side with your app on every node), Deployment + LoadBalancer/Ingress (centralized proxy), or a static binary on a VM with the provided systemd unit. One size is not forced; the chart's `edge.kind` value selects.

### 4.3 Data flow

**Identity model (foundational):** An agent's canonical network identity is its **public-key-backed DID** (`did:key:<...>`). Observed fingerprints (JA4 + canonicalized headers + key hash) are **aliases** correlated to that DID, with an explicit assurance level:

- `verified_key` — the agent proved control of the private key (registered with VeriLink).
- `correlated_behavioral` — a fingerprint was observed and correlated to a registered agent.
- `unknown` — no registration; the fingerprint has no canonical identity (score 0, policy default).

The durable identity anchor is the key hash. JA4 and header layers are corroboration; any UA version bump changes the observed fingerprint but does not reset reputation as long as the key hash is present and matches.

**Attestation ingest:**

1. A counterparty observes an agent's behavior.
2. The counterparty's service calls `control-plane POST /v1/attestations/submit` with a signed JWS token (via the Go or Node client).
3. The control plane **synchronously** resolves the issuer's current public key from the global `issuers` registry, calls `trust-engine.VerifyAttestation` over gRPC with the token **and the public key** (the engine is stateless; it cannot verify without the key supplied by the caller), and validates schema and `jti`/dedup.
4. On success, the attestation is stored transactionally in Postgres (global `attestations` table). Invalid attestations receive a **deterministic 4xx** response — they are not asynchronously accepted.
5. A `RunVeriRank` job is enqueued for the **network** (one global run, debounced — one run per minute, or immediately if no run is in flight). Per-tenant recompute is not needed because scores are global.

**Score computation:**

1. The control plane's `graph` domain loads the global attestation set from Postgres.
2. It calls `trust-engine.RunVeriRank` over gRPC with the attestation set, the global issuer list, the bootstrap roots, and an **explicit `evaluation_time`** (the engine must be deterministic — it currently calls `time.Now()`, which will be fixed).
3. The trust engine runs VeriRank (max four hops, distance decay `0.8^d`, time decay `e^(-λt)` with half-life 180 days — matching `TimeDecayHalfLifeDays = 180.0` in `pkg/trust/engine.go:15`) and returns a score table keyed by **canonical network subject (DID)**.
4. The control plane writes results to the global `network_scores` table (durable) and to Redis (the sync buffer, rebuilt from Postgres after restart), and advances the monotonic `score_version` sequence.

**Edge sync (versioned contract):**

1. `edge-verifier` boots with a tenant API key over TLS (API key is sufficient for v1; mTLS deferred — see 4.7).
2. It fetches a **full snapshot**: `GET /v1/sync/snapshot` returns a versioned, compressed REST payload containing the global score table and this tenant's policy. The edge replaces its in-memory snapshot **atomically** (immutable map swap, not an LRU — a known agent must never be silently evicted).
3. Subsequent updates arrive as **SSE deltas** keyed by a monotonic `Last-Event-ID` (the `score_version`). If the cursor is expired (the control plane has advanced beyond a retained window), the SSE response is `410 Gone` with a directive to fetch a new full snapshot.
4. The edge persists each snapshot to disk **atomically** (`snapshot.json.tmp` → `rename`) so an ungraceful crash never corrupts the cache.
5. Postgres is the durable truth; Redis is rebuilt from Postgres after a restart.

**Allow/deny decision:**

1. An inbound agent request hits `edge-verifier` on port 8080.
2. The edge computes the fingerprint in Go (`pkg/fingerprint` — `map[string]string` headers canonicalized via sort + `headers_hash`, plus JA4, protocol, key hash).
3. It resolves the fingerprint to a canonical DID (via the alias table in the snapshot) and looks up the network score.
4. **Unknown fingerprint** (not in the snapshot's alias map) → score 0 → policy default action. This is distinct from **degraded mode** (sync outage).
5. Per the tenant's policy: `allow` (proxy to backend, `X-Verilink-Status: Allowed`) or `deny` (403, `X-Verilink-Status: Denied`). **No `challenge` action in v1.**
6. The decision is written to a **bounded local WAL** (not the control-plane `audit_log` directly) and flushed in batches to the control plane's `events/` domain asynchronously — never blocking the data path. See Section 7.2.

### 4.4 Trust-engine gRPC contract

Corrected to match the actual `pkg/fingerprint` (headers map, not User-Agent string) and `pkg/trust` (score-only output) implementations.

```proto
service TrustEngine {
  rpc RunVeriRank(RunRequest) returns (ScoreTable);
  rpc VerifyAttestation(VerifyRequest) returns (VerifyResult);
  rpc Fingerprint(FingerprintRequest) returns (Fingerprint);
}

// RunVeriRank: deterministic given the same inputs + evaluation_time.
// The control plane supplies all data; the engine holds no state.
message RunRequest {
  repeated Attestation attestations = 1;
  repeated Issuer issuers = 2;            // includes trust_weight and is_bootstrap
  repeated string root_dids = 3;         // bootstrap roots of trust
  int64 evaluation_time_unix = 4;        // REQUIRED — engine must not call time.Now()
}
message Attestation {
  string issuer_did = 1;
  string subject_did = 2;                // canonical network subject
  int32 trust_delta = 3;                 // vli.trust_level_delta
  int64 issued_at_unix = 4;
  int64 expires_at_unix = 5;             // optional; 0 = no expiry
  string attestation_type = 6;           // transaction_summary | kyb | security_audit | negative_incident | behavioral
  string jti = 7;                         // advisory; dedup is by token digest in the control plane
}
message Issuer {
  string did = 1;
  double trust_weight = 2;               // 0.0..1.0 multiplier (applied in the engine)
  bool is_bootstrap = 3;
  int32 seed_score = 4;                  // for bootstrap roots only
}

// Output: score only. confidence/hop_count/blacklisted are NOT computed by
// the current engine and are cut from v1. Blacklisting is applied by zeroing
// the score; the control plane infers blacklist state from score == 0.
message ScoreTable {
  repeated ScoreRow rows = 1;
  int64 computed_at_unix = 2;             // echoes evaluation_time for traceability
}
message ScoreRow {
  string subject_did = 1;               // canonical network subject, NOT a db agent_id
  int32 score = 2;                      // 0..100
}

// VerifyAttestation: caller supplies the issuer's public key (engine is stateless).
message VerifyRequest {
  string jws_token = 1;
  bytes issuer_public_key = 2;           // Ed25519 public key, resolved by the caller
}
message VerifyResult {
  bool valid = 1;
  string issuer_did = 2;
  string subject_did = 3;
  AttestationPayload payload = 4;
  string error = 5;                      // populated when valid == false
}
message AttestationPayload {
  string attestation_type = 1;
  map<string, string> facts = 2;         // string-coerced; structured facts are JSON in the control plane
  int32 trust_level_delta = 3;
  int64 issued_at_unix = 4;
  int64 expires_at_unix = 5;
  string jti = 6;
}

// Fingerprint: matches pkg/fingerprint.Generate exactly.
message FingerprintRequest {
  string ja4 = 1;
  map<string, string> headers = 2;       // sorted + canonicalized into headers_hash by the engine
  string key_hash = 3;
  string protocol = 4;
}
message Fingerprint { string sha256 = 1; }
```

**Engine work required for v1 (not a "thin ~200-line wrapper"):**

1. **Determinism fix:** replace `time.Now()` calls in `addAttestationLocked` and `calculateTimeDecay` with the supplied `evaluation_time`. New tests required.
2. **`issuer.trust_weight` application:** the current engine applies `DistanceDecay` and `timeDecay` but no per-issuer weight. Applying `trust_weight` as a multiplier on each contribution is a change to the trust math and requires new property-based tests (monotonicity, decay invariants). This is acknowledged engine work, not a wrapper.
3. **Score-row identity:** output keyed by `subject_did` (canonical), not `agent_id` (database). The control plane maps DIDs to registered agents for display.
4. **`confidence`/`hop_count`/`blacklisted` are cut from v1.** The engine returns score only; the dashboard infers blacklist from `score == 0`. If richer metadata is needed post-v1, the engine is extended then.

### 4.5 Reused vs. adapted (delta from Whimsy)

"Direct port" was an overstatement. The Whimsy modules are a strong starting point but require substantial adaptation for VeriLink's global-graph, OIDC, multi-tenant, and billing model.

| Whimsy module | VeriLink use | Adaptation |
|---|---|---|
| `api/src/db/{client,migrate,transaction}.js` | Adapt | New schema; same Pool/migrate patterns |
| `api/src/middleware/auth.js` | **Substantial adaptation** | Drop Firebase Admin, add OIDC subject validation, add `vrl_` key format, add membership resolution, add tenant-billing gating. HMAC-SHA256 key hashing is the part that ports cleanly. |
| `api/src/middleware/{rateLimit,audit}.js` | Adapt | Per-tenant quotas by plan; audit schema differs |
| `api/src/authz/` (RBAC) | Adapt | Define VeriLink resources (`agent`, `issuer`, `attestation`, `policy`, `tenant`, `billing`); global-vs-tenant resource distinction |
| `api/src/shared/{logger,redis,apiKeyRequestActivity,encryption,openapi}.js` | Adapt | New key patterns for global graph + sync cursors; new audit actions |
| `app/` Vite + Radix + TanStack + shadcn kit | Fork as scaffold | Strip Whimsy features; add VeriLink views; read-only graph summaries (no `@xyflow/react` explorer in v1) |
| `api/src/domains/billing/*` (Stripe patterns) | Adapt | Reuse checkout/portal/webhook constructs; new subscription tiers; persist processed webhook IDs for dedup |

### 4.6 What stays Go

The trust-core algorithms stay in Go as `pkg/*` because they are correct and tested. Reimplementing VeriRank, the JWS attestation codec, and the fingerprint logic in TypeScript would risk divergence. A Go gRPC server (`cmd/trust-engine`) exposes the existing packages to the TypeScript control plane. The engine requires the determinism and `trust_weight` fixes in 4.4 before it can serve the control plane.

The edge stays Go for v1. The existing `cmd/edge-verifier` already meets the `VR-002` budget (10k req/s, <1ms overhead, per the ROADMAP completion notes). Hardening work for v1: TLS termination, the versioned sync client, the atomic in-memory snapshot, the bounded local WAL for decision telemetry. The Rust rewrite is deferred to post-v1 behind the FFI parity harness (`scripts/parity-check.sh` runs a matrix of raw HTTP/TLS request fixtures against Go and Rust to guarantee byte-identical SHA-256 fingerprints across all TLS client hellos).

### 4.7 mTLS scope (v1)

Issuing and rotating edge client certificates means running a CA, which is out of scope for v1. v1 uses **tenant API keys over TLS** for edge-to-control-plane auth. mTLS is deferred to post-v1 alongside the Rust edge; if it returns, the spec will name the PKI mechanism at that time.

### 4.8 Whimsy as first reference customer

Whimsy's existing `api/src/shared/verilink.js` module already integrates with the VeriLink attestation API. Post-productization, this module points at the hosted control plane, and Whimsy becomes the first seeded issuer. Two compatibility points require migration (see Section 6.3): the `behavioral` attestation type and the absent `jti`.

---

## 5. Data model

Postgres. The graph is **global**; tenants own policies, API keys, memberships, edge nodes, and billing. Isolation is **application-level** (the ported `authz/` layer injects `WHERE tenant_id = $1` on tenant-scoped tables) — not PostgreSQL Row-Level Security in v1. Tenant-scoped tables carry `tenant_id` and use **composite tenant-safe foreign keys** to prevent cross-tenant references. Global tables have no `tenant_id`.

### 5.1 Global graph tables

```sql
-- Canonical agent identities (network-wide)
agents (
  did             text pk,                  -- did:key:<...>, the public-key-backed canonical ID
  name            text,
  owner_tenant_id uuid references tenants(id),  -- the tenant that registered this agent (may be null for bootstrap seeds)
  public_key_jwk  jsonb not null,
  metadata        jsonb default '{}',
  first_seen_at   timestamptz not null default now(),
  last_seen_at    timestamptz not null default now(),
  status          text not null default 'active'  -- active | revoked
);

-- Observed fingerprints correlated to canonical agents (aliases)
agent_fingerprints (
  fingerprint     text not null,            -- sha256 hex from pkg/fingerprint.Generate
  agent_did       text not null references agents(did),
  assurance_level text not null,            -- verified_key | correlated_behavioral | unknown
  first_seen_at   timestamptz not null default now(),
  last_seen_at    timestamptz not null default now(),
  primary key (fingerprint, agent_did)
);

-- Issuers: entities that sign attestations (global)
issuers (
  did             text pk,                  -- did:key:<...>
  name            text not null,
  public_key_jwk  jsonb not null,           -- current key
  trust_weight    numeric(3,2) default 1.0, -- 0.00..1.00 (applied inside VeriRank)
  is_bootstrap   boolean default false,
  verified_at     timestamptz,
  created_at      timestamptz not null default now()
);

-- Issuer key history + revocation
issuer_keys (
  id              uuid pk,
  issuer_did      text not null references issuers(did),
  public_key_jwk  jsonb not null,
  valid_from      timestamptz not null,
  valid_until     timestamptz,              -- null = current; set on rotation/revocation
  revoked_at      timestamptz,
  revocation_reason text
);

-- Attestations: signed behavioral reports (global)
attestations (
  id              uuid pk,
  issuer_did      text not null references issuers(did),
  subject_did     text not null references agents(did),
  jws_token       text not null,
  token_digest    text not null,            -- sha256(jws_token); UNIQUE, used for dedup (not nullable jti)
  payload         jsonb not null,
  facts           jsonb not null,
  trust_delta     integer not null,
  attestation_type text not null,           -- transaction_summary | kyb | security_audit | negative_incident | behavioral
  jti             text,                     -- advisory; may be null
  issued_at       timestamptz not null,
  expires_at      timestamptz,
  superseded_by   uuid references attestations(id),  -- retraction/supersession chain
  sig_verified    boolean not null default true,
  received_at     timestamptz not null default now(),
  unique (token_digest)                     -- dedup on token hash; jti is advisory
);

-- Network scores: materialized VeriRank output (global, canonical)
network_scores (
  subject_did     text not null references agents(did),
  score           integer not null,         -- 0..100
  computed_at     timestamptz not null default now(),
  score_version   bigint not null,          -- monotonic; the sync cursor
  primary key (subject_did)
);

-- Score history (for dashboard time-series)
network_score_history (
  subject_did     text not null references agents(did),
  score           integer not null,
  computed_at     timestamptz not null,
  score_version   bigint not null,
  primary key (subject_did, score_version)
);

-- Bootstrap registry: VeriLink-seeded root of trust (source of truth)
bootstrap_registry (
  did             text pk references issuers(did) or agents(did),  -- must exist in the global tables
  name            text not null,
  kind            text not null,           -- agent | issuer
  seed_score      integer not null,
  seeded_at       timestamptz not null default now(),
  de_emphasized_at timestamptz              -- set when organic volume replaces this seed
);
```

`bootstrap_registry` is the source of truth; the seeder (`domains/bootstrap`) materializes its entries into `issuers`/`agents` with `is_bootstrap = true`. There is no separate `issuers.is_bootstrap` column maintained by hand — it is derived from the registry.

### 5.2 Tenant-scoped tables

```sql
tenants (
  id           uuid pk,
  slug         text unique not null,
  name         text not null,
  plan         text not null default 'free',  -- free | pro | enterprise
  status       text not null default 'active',
  created_at   timestamptz not null default now()
);

-- Global users (a developer may belong to multiple tenants)
users (
  id           uuid pk,
  email        citext unique not null,
  oidc_issuer  text not null,            -- Clerk issuer URL (or self-hosted OIDC issuer)
  oidc_subject text not null,            -- OIDC sub claim
  created_at   timestamptz not null default now(),
  unique (oidc_issuer, oidc_subject)
);

-- Tenant memberships (junction; a user can be in multiple tenants with different roles)
tenant_memberships (
  user_id      uuid not null references users(id),
  tenant_id    uuid not null references tenants(id),
  role         text not null default 'member',  -- owner | admin | member
  created_at   timestamptz not null default now(),
  primary key (user_id, tenant_id)
);

-- API keys — adapts Whimsy middleware/auth.js (HMAC-SHA256)
api_keys (
  id              uuid pk,
  tenant_id       uuid not null references tenants(id),
  key_prefix      text not null,           -- first 12 chars, shown in UI
  key_hash_hmac   text not null,           -- HMAC-SHA256 keyed by API_KEY_HMAC_SECRET
  scopes          text[] not null,         -- attest:write | attest:read | sync:read | policy:admin | tenant:admin | billing:read
  last_used_at    timestamptz,
  created_at      timestamptz not null default now(),
  revoked_at      timestamptz
);
-- No key_hash_legacy column: this is a new product; no legacy vrl_ keys to migrate.

-- Policies: per-tenant threshold + action (overlay on global scores)
policies (
  id              uuid pk,
  tenant_id       uuid not null references tenants(id),
  name            text not null,
  threshold       integer not null default 50,  -- 0..100; score < threshold = policy action
  action          text not null default 'deny', -- allow | deny (no challenge in v1)
  fingerprint_rules jsonb default '{}',
  is_active       boolean not null default true,
  created_at      timestamptz not null default now(),
  unique (tenant_id, name),
  -- only one active policy per tenant
  partial unique index active_policy_per_tenant on (tenant_id) where is_active
);

-- Edge nodes (per tenant)
edge_nodes (
  id              uuid pk,
  tenant_id       uuid not null references tenants(id),
  name            text not null,
  api_key_id      uuid references api_keys(id),
  last_seen_at    timestamptz,
  last_sync_version bigint,                -- the score_version of its last successful sync
  status          text not null default 'unknown',  -- healthy | stale | unknown
  created_at      timestamptz not null default now()
);

-- Sync cursors (per tenant + edge node)
sync_cursors (
  tenant_id       uuid not null references tenants(id),
  edge_node_id    uuid not null references edge_nodes(id),
  last_cursor     bigint not null default 0,   -- the score_version
  last_sync_at    timestamptz,
  snapshot_hash   text,
  primary key (tenant_id, edge_node_id)
);

-- Subscriptions (Stripe)
subscriptions (
  id              uuid pk,
  tenant_id       uuid not null references tenants(id),
  stripe_customer_id   text not null,
  stripe_subscription_id text not null,
  plan            text not null,
  status          text not null,           -- active | past_due | canceled | ...
  current_period_end timestamptz,
  created_at      timestamptz not null default now()
);

-- Stripe webhook event dedup
stripe_webhook_events (
  id              text pk,                 -- Stripe event id
  received_at     timestamptz not null default now(),
  processed_at    timestamptz,
  payload         jsonb not null
);

-- Decision events: high-volume, from the edge (separate from audit_log)
decision_events (
  id              bigserial pk,
  tenant_id       uuid not null references tenants(id),
  edge_node_id    uuid references edge_nodes(id),
  fingerprint     text not null,
  resolved_did    text,                    -- may be null for unknown fingerprints
  score           integer,
  action          text not null,           -- allow | deny
  decided_at      timestamptz not null,
  received_at     timestamptz not null default now()
);

-- Audit log: administrative/state-change events only (low volume)
audit_log (
  id              bigserial pk,
  tenant_id       uuid not null references tenants(id),
  actor_type      text not null,           -- user | api_key | edge_node | system
  actor_id        text,
  action          text not null,           -- attestation.submit | policy.update | api_key.revoke ...
  resource        text not null,
  resource_id     text,
  metadata        jsonb default '{}',
  ip              text,
  user_agent      text,
  created_at      timestamptz not null default now()
);
```

### 5.3 Tenant isolation

**Application-level isolation**, not PostgreSQL RLS, in v1. The ported `authz/` layer injects `WHERE tenant_id = $1` on tenant-scoped tables. Global graph tables (`agents`, `issuers`, `attestations`, `network_scores`) are intentionally readable across tenants — that is the network. Tenant-scoped tables use **composite tenant-safe foreign keys**: where a tenant-scoped table references another tenant-scoped table, the FK includes `tenant_id` on both sides to prevent a row in tenant A referencing a row in tenant B. (No such cross-references exist in the v1 schema — `edge_nodes` and `sync_cursors` reference only `tenants` and `api_keys`, both via the tenant's own `tenant_id`.)

### 5.4 Multi-tenancy model

Row-level isolation with a shared schema. The OSS self-hosted deployment runs the same code with a single tenant. Enterprise tenants who need physical isolation run their own self-hosted deployment (same code, same Helm chart). One code path.

### 5.5 Data retention and privacy

Attestation `facts` are free-form JSON from counterparties and may carry personal data. v1 policy:

- Attestations are retained for the life of the issuing issuer's relationship + 1 year, then archived.
- A subject agent owner may request deletion of their agent's record; attestations about that agent are anonymized (subject_did replaced with a tombstone) rather than deleted, to preserve graph integrity.
- Decision events are retained 90 days (pro) / 1 year (enterprise); audit log entries 90 days (pro) / 1 year (enterprise).
- A `/v1/privacy/export` and `/v1/privacy/delete` endpoint is in scope for v1 to support GDPR/CCPA subject-access requests.

---

## 6. Security

| Concern | Measure |
|---|---|
| **Signature verification** | Ed25519 (EdDSA). The trust engine verifies every JWS against the issuer's current public key, which the **caller supplies** in `VerifyRequest` (the engine is stateless). Unknown issuer: reject and audit. Issuer key rotation is supported via `issuer_keys` history; revoked keys fail verification. |
| **API key storage** | HMAC-SHA256 keyed by `API_KEY_HMAC_SECRET` (≥16 chars). Raw keys never persisted. No `key_hash_legacy` column — new product, no legacy keys. |
| **API key format** | `vrl_<64hex>`. Regex `/^vrl_[A-Za-z0-9_-]{32,128}$/`. Extraction via `Authorization: Bearer` or `X-API-Key` (Whimsy's tightened parser logic, adapted). |
| **Tenant isolation** | Application-level: the ported `authz/` layer injects `WHERE tenant_id = $1` on tenant-scoped tables. Global graph tables are cross-tenant by design. |
| **RBAC scopes** | `attest:write`, `attest:read`, `sync:read`, `policy:admin`, `tenant:admin`, `billing:read`. API keys carry scopes; dashboard users carry roles mapped to scopes via `authz/decision.js`. |
| **Rate limiting** | Per-tenant quotas by plan: free (100 attestations/day, 1 sync/min), pro (10k/day, 10 sync/min), enterprise (custom). Edge sync (snapshot + SSE) is exempt from request rate limits. |
| **Edge to control-plane auth** | Tenant API key over TLS in v1. mTLS deferred (see 4.7). |
| **Customer issuer private keys** | **Never enter VeriLink.** VeriLink stores issuer **public keys** only. The only private key VeriLink holds is its own bootstrap signing key, in KMS/HSM. |
| **Audit** | `audit_log` is for **state-changing administrative events only** (attestation submit accepted, policy update, API key create/revoke, tenant billing change). High-volume edge decisions go to `decision_events`, batched through a bounded local WAL — see 7.2. |
| **Bootstrap registry protection** | Only `tenant:admin` on the VeriLink staff tenant can edit `bootstrap_registry`. Bootstrap issuers carry `is_bootstrap = true` (derived from the registry) and are visually distinct in the dashboard. |
| **Replay protection** | Attestations carry `iat`/`exp`. The engine rejects expired or future-dated tokens. Dedup is on `token_digest` (sha256 of the JWS, `UNIQUE NOT NULL`) — not nullable `jti`, which would permit unlimited duplicates. `jti` is advisory. |
| **Fail-closed edge** | Unknown fingerprint → score 0 → policy default (deny). Degraded mode (sync outage) falls back to the last good snapshot with a max acceptable age (see 7.1); beyond that age the edge fails closed (503). |

### 6.1 Abuse and Sybil resistance

The structural defense is VeriRank itself: trust propagates **only from roots of trust**. An attacker who mints sock-puppet issuers and has them attest to their own agent gets **zero score**, because the puppet cluster is unrooted — no path from a bootstrap root reaches it. This is already true in `pkg/trust/engine.go` (only nodes reachable from `rootsOfTrust` accumulate score).

Additional controls:

- **Issuer verification process:** `issuers.verified_at` is set only after proof of key control (the issuer signs a challenge) and, for higher trust weights, manual review by VeriLink staff. Unverified issuers default to `trust_weight = 0` (their attestations are stored but contribute no score) until verified.
- **Agent ownership proof:** registering an agent requires signing a challenge with the agent's private key, proving the registrant controls it.
- **Attestation taxonomy and schema validation:** the control plane validates `attestation_type` against the allowed enum and validates `facts` against a per-type JSON schema before storing. Unknown types are rejected with 4xx.
- **Negative-report dispute/moderation:** a negative attestation (`negative_incident`) from a highly trusted issuer (score ≥ 80, the `BlacklistIssuerThreshold` in `pkg/trust/engine.go:17`) zeroes the subject's score. The subject may file a dispute (a moderation queue in the control plane); disputes do not auto-revoke the blacklist but flag it for staff review.
- **Issuer/key revocation:** `issuer_keys.revoked_at` + `revocation_reason` records revocation; revoked keys fail verification. An issuer can be entirely deactivated by revoking all its keys.
- **Attestation retraction/supersession:** `attestations.superseded_by` chains retractions. A retraction does not rewrite history; a new attestation with `superseded_by` pointing at the old one replaces it in the next VeriRank run.
- **Visibility of sensitive facts:** `facts` may be marked `_private` by the issuer (a key prefix convention); the control plane redacts `_private` keys in API responses to non-issuer, non-subject tenants. Aggregate reputation (score) is always visible to all tenants; raw facts are visible only to the issuer, the subject's owner, and VeriLink staff.

### 6.2 JA4 and TLS termination

JA4 requires visibility into the TLS ClientHello. Deployment shapes and degraded-fingerprint behavior:

- **Edge terminates TLS:** full JA4 available. The recommended deployment for maximum fingerprint strength.
- **Edge behind an existing LB or Cloudflare:** JA4 is unavailable. The fingerprint collapses to `headers_hash + key_hash + protocol` (no `ja4` field). The edge sets `X-Verilink-Fingerprint-Mode: full` or `degraded` so the backend and the dashboard know the assurance level.
- **Identity continuity:** the durable anchor is `key_hash`. A UA version bump changes `headers_hash` and produces a new observed fingerprint, but as long as `key_hash` matches a registered agent, the new fingerprint is correlated as a `correlated_behavioral` alias of the same canonical DID — reputation is not reset. Agents without a key hash have no durable identity; any transport change resets their reputation.

### 6.3 Whimsy compatibility (migration required)

Two concrete incompatibilities between Whimsy's current `shared/verilink.js` and the v1 schema:

1. **`type: "behavioral"`** is not in the proposed enum. **Resolution:** add `behavioral` to the allowed `attestation_type` enum. The enum becomes `transaction_summary | kyb | security_audit | negative_incident | behavioral`.
2. **No `jti`** in Whimsy's current payload (`signJWT` in `verilink.js:131` does not set `jti`). **Resolution:** dedup is on `token_digest` (sha256 of the JWS), not `jti`. Whimsy's existing tokens dedup correctly without modification. `jti` is advisory; a future Whimsy update may add it.

The Whimsy attestation payload (`vli: { type: "behavioral", facts, trust_level_delta }`) is otherwise compatible with the existing `pkg/attestation` schema. Whimsy's `remoteFingerprint` (a hash of `userId:remoteId:provider`, representing a storage remote, not an autonomous agent) means Whimsy is the first **issuer**, not a proof of provider-side agent identification. A separate reference customer demonstrating agent identification is needed before launch (open item, Section 15).

---

## 7. Error handling

### 7.1 Edge (`edge-verifier`, Go)

The data path never crashes. Three distinct states, **not conflated**:

| State | Definition | Behavior |
|---|---|---|
| **Unknown fingerprint** | The fingerprint is not in the current snapshot's alias map | Score 0; apply policy default action (deny). Set `X-Verilink-Status: Denied`, `X-Verilink-Reason: unknown`. This is the **common case**, not an error. |
| **Degraded (sync stale)** | The last successful snapshot is older than `MAX_SNAPSHOT_AGE` (v1 default: 5 minutes) | Fail closed: return 503 with `X-Verilink-Mode: stale`. The edge does not serve a stale snapshot beyond the max age — a revoked or newly blacklisted agent could otherwise remain allowed indefinitely. |
| **Degraded (sync unreachable, snapshot fresh)** | The sync API is unreachable but the last snapshot is within `MAX_SNAPSHOT_AGE` | Serve the snapshot; set `X-Verilink-Mode: degraded`. Retry sync with exponential backoff (1s → 30s cap). Surface to the control plane via the telemetry channel so the dashboard shows the edge node as `stale`. |

The in-memory snapshot is an **immutable map** (atomic swap on update), not an LRU — a known agent must never be silently evicted. A cache miss in the current snapshot means "unknown" (state 1), never "fall back to an older snapshot."

### 7.2 Control plane (`control-plane` TS)

Whimsy-style structured errors via an adapted `shared/errors/` module. Express error middleware normalizes. Attestation ingest: **signature and schema are verified synchronously; storage is transactional; only score recomputation is enqueued.** Invalid attestations receive a deterministic 4xx — they are never asynchronously accepted. `RunVeriRank` failures retry three times then dead-letter; `network_scores` stays at the last-good value with `computed_at` aging; the dashboard shows a staleness warning after one hour.

**Decision-event ingestion** is decoupled from the data path: the edge writes decisions to a bounded local WAL, flushes in batches to the control plane's `events/` domain, and uses at-least-once delivery with dedup on (edge_node_id, decided_at, fingerprint). If the WAL fills (the control plane is unreachable for too long), the edge **blocks** new decisions once the WAL is at capacity — this is the explicit tradeoff: an audit gap is preferable to silently dropping decisions. The success criterion is relaxed accordingly (Section 16).

### 7.3 Trust engine (`trust-engine` Go)

Stateless gRPC. Returns standard codes (`InvalidArgument`, `Unauthenticated`, `Internal`). `RunVeriRank` is idempotent given the same inputs and `evaluation_time`. Panics in a VeriRank run are caught at the handler boundary and returned as `Internal`; the goroutine survives.

### 7.4 Failure notifications

**Sentry plus Prometheus/Alertmanager** for service failures. The n8n `settings.errorWorkflow` / Error Trigger pattern applies to n8n workflow executions, not to an Express service — it is removed from this design. An n8n webhook may be added later as an optional downstream notification integration, but it is not the failure-detection mechanism.

---

## 8. Observability

| Signal | Source | Tool |
|---|---|---|
| **Metrics** | `edge-verifier` (latency histogram of **local decision overhead only**, excluding upstream service time; allow/deny counter; cache hit rate; WAL depth), `control-plane` (request rate, VeriRank duration, sync lag, decision-event ingest lag), `trust-engine` (gRPC duration, verify failures) | Prometheus scrape + Grafana |
| **Logs** | Structured JSON (adapt `shared/logger.js`). | Loki or CloudWatch |
| **Traces** | OpenTelemetry across all three languages; trace context propagated edge → control plane → trust engine. | OTLP collector → Tempo or Jaeger |
| **Error tracking** | Sentry (adapt Whimsy's `@sentry/node` and `@sentry/react` setup). | Sentry |
| **Internal dashboards** | Graph size, VeriRank lag, edge-node health, tenant signups. | Grafana |
| **Tenant-facing dashboards** | Inside the product: providers see aggregated allow/deny counters and sampled decisions (not every decision); builders see their agent's score history. | Product dashboard (recharts) |
| **Healthchecks** | `edge-verifier /healthz` (cache age, last sync version, backend reachability), `control-plane /healthz` (DB, Redis, trust-engine reachability), `trust-engine /healthz`. | Kubernetes liveness/readiness probes |

---

## 9. Testing

| Layer | Approach |
|---|---|
| **Go core (`pkg/*`)** | Existing unit tests stay. Add property-based tests for VeriRank (decay invariants, monotonicity under positive attestations, unrooted-cluster zero-score invariant). New tests for the `evaluation_time` determinism fix and `trust_weight` application. gRPC contract tests for `cmd/trust-engine`. |
| **Go edge (`cmd/edge-verifier`)** | Integration test: spin up a mock backend, send trusted, unknown, and denied requests, assert status + headers. The **latency benchmark (`VR-002`) is a dedicated-hardware nightly-staging gate**, not a PR gate — shared CI runners cannot reliably measure sub-millisecond p99. The gate measures **local decision overhead only** (excluding upstream service time) on a pinned performance runner with a fixed workload. |
| **TS control plane** | Jest (adapt Whimsy's setup). Unit tests for adapted modules. Integration tests against a real Postgres and Redis. Contract tests against the gRPC trust engine using a test container. |
| **TS dashboard** | Vitest (unit) + Playwright (e2e). Golden path: onboard a tenant, register an agent, submit an attestation, see the score, configure a policy. |
| **Cross-language parity (post-v1)** | `scripts/parity-check.sh` runs a matrix of raw HTTP/TLS request fixtures against Go `pkg/fingerprint` and Rust `edge-rs/fingerprint` to guarantee byte-for-byte SHA-256 agreement across all TLS client hellos. This is the gate for the Rust edge to graduate from post-v1. |
| **Load** | **k6** (selected over oha) against `edge-verifier` for the 10k req/s `VR-002` gate, nightly in staging. |
| **Security** | `semgrep` on TS and Go. `cargo audit` on Rust (when edge-rs lands). Secret scan pre-commit. |

---

## 10. Deployment

### 10.1 Artifacts (in `deploy/`)

- `docker/Dockerfile.edge` — Go, multi-stage, distroless, `CGO_ENABLED=0` (also yields the static binary).
- `docker/Dockerfile.control-plane` — TypeScript, multi-stage.
- `docker/Dockerfile.trust-engine` — Go, multi-stage, distroless.
- `docker/docker-compose.self-host.yml` — all three services plus Postgres and Redis, for self-hosted OSS users.
- `helm/` — configurable topology: `edge.kind` selects `DaemonSet` | `Deployment` | (static binary users skip Helm). Control-plane and trust-engine as Deployments with HPAs. Postgres and Redis via upstream charts.
- `systemd/verilink-edge.service` — unit template + sample config for bare-metal/VM deployments.
- **Static binary releases:** Linux x86_64 and aarch64, statically linked (musl-equivalent for Go: `CGO_ENABLED=0` + `rustls` if Rust), published to GitHub Releases with checksums, SBOM, and signed releases.

### 10.2 Local dev

`scripts/dev-up.sh` — orchestrates all three services plus Postgres and Redis via Docker Compose, seeds the bootstrap registry, and prints the dashboard URL.

### 10.3 Hosted SaaS

Hosted in OCI Toronto (us-ashburn-1 or the primary OCI region), co-located with Whimsy/Codero. The hosted control plane runs the same code as self-host, with `VERILINK_MULTI_TENANT=true`. Single region in v1. **Backup/restore testing, RPO/RTO, and off-host backup requirements are in scope for v1** — the hosted Postgres has daily snapshots + WAL archiving, with a quarterly restore drill.

### 10.4 Docs site

Docusaurus, in `docs/`, versioned, with MDX and OpenAPI/Redoc rendering. Schema references, quickstarts, integration guides (Envoy/Nginx/Kong), self-host guide.

---

## 11. Dashboard

TypeScript Vite SPA, reusing the Numera/Whimsy kit (Radix UI, TanStack Router/Query, Tailwind, shadcn-style components, recharts, sonner, Sentry). Served by the control plane behind the same auth context.

### 11.1 Provider view

- Trust-score summary: aggregated allow/deny counters over time (recharts), top agents by traffic, top denied fingerprints. **No interactive graph explorer in v1.**
- Sampled decision feed (not every decision — see 7.2).
- Agent list with current canonical scores and last-seen.
- Policy editor: threshold slider, fingerprint-pattern rules. (No per-tenant issuer-weight overrides in v1 — issuer weights are global, applied inside VeriRank; per-tenant weighting is deferred.)
- API key management.
- Edge-node sync status (last sync version, cursor lag, stale flag).
- Billing portal links (Stripe Customer Portal).

### 11.2 Agent-builder view

- Registered agents list (by canonical DID + observed fingerprint aliases + assurance level).
- Attestation feed: incoming (counterparties attesting to this agent) and outgoing (this builder attesting about others).
- Trust score over time (recharts, from `network_score_history`).
- Issuer relationships.
- Billing portal links.
- **No reputation badge in v1** (deferred to post-v1).

### 11.3 Admin (VeriLink staff) view

- Bootstrap registry editor (add/de-emphasize seed issuers and agents).
- Tenant list with plan and usage.
- Graph health: total nodes, total edges, VeriRank lag, bootstrap-vs.-organic ratio.
- Issuer verification queue (proof-of-key-control challenges, manual review for higher trust weights).

### 11.4 Graph visualization (v1)

**Read-only summaries only.** Node/edge counts, top issuers by outgoing attestation volume, path-summary cards for a selected agent (which roots reach it, hop count, decayed contribution). The interactive `@xyflow/react` explorer is deferred to post-v1.

---

## 12. Clients

| Client | Status | v1 action |
|---|---|---|
| `client/go` | Existing, working | Unchanged API; update default URL to the hosted control plane. |
| `client/node` | Existing, vendored from source | Publish to npm as `@verilink/node` with TypeScript types. |
| `client/rust` | Deferred with `edge-rs` | Post-v1. |

All clients target the same REST API surface (`/v1/attestations/submit`, `/v1/trust`, `/v1/sync/snapshot`, `/v1/sync/events`). The Node client's existing `VeriLinkClient.fromEnv()` pattern is preserved.

---

## 13. v1 scope and sequencing

The v1 scope is the full control plane plus the hardened OSS toolkit, both sides onboarding from day one — with the edge staying Go (Rust deferred). Sequencing:

1. **Monorepo restructure + CI** — new directory layout, CI for Go + TS, cross-language parity harness scaffold (Go-only in v1; Rust side lands post-v1).
2. **Engine fixes** — `evaluation_time` determinism, `trust_weight` application, `subject_did` output keying. New tests. This unblocks the control plane.
3. **Trust-engine gRPC** — wrap `pkg/*` in the gRPC server per the corrected contract (4.4). Contract tests.
4. **Control-plane TS foundation** — adapt Whimsy's `db/`, `middleware/`, `authz/`, `shared/` modules. Stand up Express with healthcheck. Run migrations against a fresh Postgres.
5. **Data model + domains** — implement the schema in Section 5: global graph tables + tenant-scoped tables. `tenant`, `registry`, `graph`, `policy`, `bootstrap`, `billing`, `events` domains.
6. **Attestation ingest end-to-end** — synchronous verify (caller supplies issuer public key), transactional store, dedup on `token_digest`, enqueue VeriRank.
7. **Network score computation** — global VeriRank run, write to `network_scores` + `network_score_history`, advance `score_version`.
8. **Edge sync API** — `GET /v1/sync/snapshot` (versioned, compressed) + SSE deltas keyed by `Last-Event-ID`; `410 Gone` on expired cursor.
9. **Go edge hardening** — TLS termination, versioned sync client, atomic in-memory snapshot (immutable map), bounded local WAL for decision events, atomic disk snapshot writes.
10. **Dashboard** — fork the kit; provider + agent-builder views; read-only graph summaries; Stripe portal links.
11. **Bootstrap registry + cold-start seed** — curate the initial root-of-truth, seed script, derive `is_bootstrap` into `issuers`/`agents`.
12. **Deployment artifacts** — Dockerfiles, Helm chart (configurable topology), systemd unit, static binary releases.
13. **Clients** — publish Node to npm; update Go client.
14. **Observability + security hardening** — Prometheus (Sentry already wired in step 4), Alertmanager, OpenTelemetry, semgrep, secret scan.
15. **Whimsy integration migration** — point `shared/verilink.js` at the hosted control plane; add `behavioral` to the enum; Whimsy becomes the first seeded issuer.
16. **Docs site** — Docusaurus; schema refs, quickstarts, integration guides, self-host guide.
17. **Backup/restore drill** — quarterly Postgres restore test in the hosted environment; verify RPO/RTO.

---

## 14. Out of scope for v1

- Rust edge verifier (deferred to post-v1 behind the parity harness).
- Rust client (deferred with the Rust edge).
- Decentralized DID resolution beyond `did:key` (the bootstrap registry substitutes for a DID network in v1).
- Per-tenant issuer weighting (issuer weights are global; per-tenant weighting undermines the meaning of a portable score and requires separate graph computation).
- The `challenge` action (no format/lifecycle designed; v1 is allow/deny only).
- Interactive trust-graph explorer (`@xyflow/react`).
- Embeddable reputation badge.
- Non-HTTP protocols (gRPC, MQTT) at the edge.
- A mobile dashboard.
- SSO/SAML for enterprise tenants (OIDC only in v1; SAML post-v1).
- mTLS for edge-to-control-plane (API key over TLS in v1).
- Metered/usage-based billing (fixed-tier subscriptions only).
- Multi-region hosted deployment (single region in v1).
- PostgreSQL Row-Level Security (application-level isolation in v1; RLS is a hardening post-v1).

---

## 15. Open questions for round 2

1. **Second reference customer for provider-side agent identification.** Whimsy proves the issuer side (attesting about remotes) but not the provider side (identifying autonomous agents at the edge). A second reference customer demonstrating real agent identification is needed before public launch. Candidate: any internal Codero/Numera API that already receives agent-like traffic.
2. **`MAX_SNAPSHOT_AGE` default.** 5 minutes is proposed; too short and sync churn dominates, too long and a revoked agent stays allowed. Needs a tunable per-tenant override.
3. **Attestation `facts` schema per type.** The enum is defined (`transaction_summary | kyb | security_audit | negative_incident | behavioral`) but the per-type JSON schema for `facts` is not. Needed before ingest goes live.
4. **Privacy redaction `_private` convention.** The prefix convention needs a formal spec and tests before launch.
5. **Bootstrap de-emphasis trigger.** At what organic-attestation volume does a bootstrap issuer get `de_emphasized_at` set? A ratio threshold (e.g., organic attestations ≥ 10x the bootstrap's) is proposed.

---

## 16. Success criteria for v1

- [ ] A provider can sign up, get an API key, run the Go `edge-verifier` in front of a backend, and receive allow/deny decisions on real agent traffic, end-to-end, in under 15 minutes from signup.
- [ ] The edge verifier holds the sub-millisecond p99 **local decision overhead** (excluding upstream service time) at 10k req/s (the `VR-002` gate), measured on a pinned nightly-staging runner, not shared CI.
- [ ] An agent builder can register an agent's public-key identity, receive an attestation from a counterparty, and see a non-zero trust score in the dashboard.
- [ ] The bootstrap registry is seeded and providers see a non-empty graph on first sync.
- [ ] Whimsy's `shared/verilink.js` points at the hosted control plane and its `behavioral` attestations appear in the graph and dedup correctly without `jti`.
- [ ] Self-hosted deployment via `docker-compose.self-host.yml` works with no manual SQL.
- [ ] The Node client is published to npm.
- [ ] Cross-language fingerprint parity test passes in CI (Go reference; Rust side lands post-v1).
- [ ] `audit_log` records every state-changing administrative event; `decision_events` records edge decisions via the bounded local WAL with at-least-once delivery and dedup. **If the WAL fills during a prolonged control-plane outage, the edge blocks new decisions rather than silently dropping them** — the audit-completeness criterion is satisfied under this explicit tradeoff.
- [ ] All three services have healthchecks wired to Kubernetes probes in the Helm chart.
- [ ] Postgres restore drill passes in the hosted environment; RPO/RTO verified.