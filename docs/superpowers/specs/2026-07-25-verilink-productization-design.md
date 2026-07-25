# VeriLink Productization Design

- **Status:** Draft v3 — review round 2 findings incorporated
- **Date:** 2026-07-25 (v3: 2026-07-25)
- **Owner:** Sanjay
- **Repo:** `/srv/storage/repo/VeriLink/`
- **Related specs:** [`docs/specs/attestation_schema.md`](../../specs/attestation_schema.md), [`docs/specs/fingerprinting.md`](../../specs/fingerprinting.md), [`docs/specs/trust_graph.md`](../../specs/trust_graph.md)
- **Related roadmap:** [`ROADMAP.yml`](../../ROADMAP.yml) (MVP Phase 0 — all six tasks complete)

---

## Change log

- **v2:** Global trust graph; corrected gRPC fingerprint contract; honest engine-work accounting; Go edge in v1 (Rust deferred); decision/audit split; token-digest dedup; identity assurance levels; Sybil resistance; JA4/TLS termination; locked Section 15 questions.
- **v3:** Resolves round-2 blocking findings: request-authentication protocol (HTTP Message Signatures, RFC 9421/9530); stable VeriLink subject IDs replacing `did:key` as the canonical identifier (rotation-capable); executable-schema corrections (composite FKs, `bootstrap_registry` split, `is_bootstrap` consistency, issuer ownership, unknown fingerprints excluded from aliases); score semantics (`blacklisted` + `score_reason`, not inferred from 0); unified sync event log covering scores + aliases + keys + policies + heartbeats; privacy deletion model (deactivate + legal-basis retention, not tombstoning); WAL drop-oldest with counters (not backpressure that blocks the data path); aggregate + sampled decision ingestion; `MAX_SNAPSHOT_AGE` keyed to last SSE heartbeat (default 5 min, tunable 1–30 min); stepwise bootstrap de-emphasis with rollback and a counterfactual removal report (manual, metric-gated); OCI region corrected to `ca-toronto-1`; API-key format locked to 64 lowercase hex; `below_threshold_action` rename; Go baseline benchmark as the first implementation gate; Clerk OAuth Application + Authorization Code/PKCE specified (no session SDK); versioned per-type facts schemas with `vli.schema_version`; attestation-level `visibility: participants|public` (no field-level `_private`).

---

## 1. Executive summary

VeriLink today is a working but internal Go toolkit for AI-agent identity and attestation: it fingerprints inbound requests, verifies signed JWS behavioral attestations, computes transitive trust scores via the VeriRank algorithm, and exposes an edge verifier reverse proxy that allows or denies traffic before it reaches an application. All six MVP roadmap tasks are complete and tests pass, but the system is in-memory only, ships no hosted surface, publishes no npm package, and the README itself states it is "not a hosted SaaS."

This document specifies how VeriLink becomes a proper product: an **open-source toolkit plus a hosted trust network** (the Tailscale/Snyk model), positioned as the trust protocol for the agentic economy. Any API provider can run the edge verifier in front of their API and make a deterministic allow/deny decision about any autonomous agent in under one millisecond, without prior registration with that provider. Any agent builder can register their agent's cryptographic identity with VeriLink, receive attestations from counterparties who observe the agent's behavior, and carry a portable reputation across the network.

The two-sided network is cold-started by VeriLink itself: a curated root-of-truth registry of known agent frameworks and public API providers, seeded at launch, de-emphasized as organic attestations take over.

The product is a single monorepo with four deployable surfaces: a Go edge verifier (v1) with a Rust edge rewrite deferred to post-v1 behind a parity harness, a TypeScript control plane and dashboard (reusing the hardened Numera/Whimsy stack — Express, Postgres, Redis, Radix, TanStack), a Go trust-engine gRPC service wrapping the existing verified algorithms, and the existing Go plus Node clients (npm-published). Whimsy is the first reference customer: its `api/src/shared/verilink.js` module already integrates with the attestation API and becomes the first seeded issuer. Codero is the second reference customer, guarding a narrow agent-ingest endpoint (`POST /memory/observations`) with an OpenCode/Codex session signing requests via the new HTTP-signature protocol.

The trust graph is **global**, not tenant-scoped. Agents, issuers, attestations, and canonical network scores are shared across the network. Tenants are a billing, ownership, API-key, and policy boundary — not a visibility boundary. One network-wide VeriRank run produces canonical scores; per-tenant thresholds and actions are applied as a policy-layer overlay at sync and decision time.

---

## 2. Product positioning

### 2.1 What VeriLink is, post-productization

The trust protocol for the agentic economy. An open-source toolkit and a hosted trust network that together let any API provider make a deterministic trust decision about any autonomous agent in under one millisecond, without prior cooperation or registration with that provider.

### 2.2 The two-sided network

**Providers** are API platforms that receive agentic traffic. They run the Go edge verifier in front of their API. The verifier verifies the inbound request's HTTP Message Signature (RFC 9421), derives the agent's key hash from the verified signature, resolves the canonical network identity, queries a local cache of trust scores synced from the hosted graph, and allows or denies the request before it reaches the application. Providers pay for the hosted control plane: trust scores, dashboards, the sync API, policy configuration, and audit.

**Agent builders** are anyone shipping an autonomous agent. They register their agent's **stable VeriLink identifier** (`vrl:agent:<uuid>`) with VeriLink, attach one or more public keys (each expressed as a `did:key`), and the agent authenticates its requests using HTTP Message Signatures with a `kid` identifying the signing key. Counterparties attest to the agent's behavior; the agent carries a portable reputation across the network. A free tier seeds this side of the network; a paid tier provides verified reputation, higher attestation volume, and an SLA.

### 2.3 The cold-start wedge

A two-sided trust network dies if it launches empty. VeriLink seeds a root-of-truth registry at launch: a curated set of known agent frameworks (with their published public keys), public API providers acting as issuers, and VeriLink's own bootstrap issuer. Providers see a non-empty graph on day one. Agent builders see value in registering because providers are already querying the graph. VeriLink's bootstrap issuer is gradually de-emphasized — manually, metric-gated — as organic attestations take over (see 6.1).

### 2.4 The moat

The trust graph data accrues only to the hosted network. The open-source toolkit is fully auditable — the trust math is transparent, which is critical for a security product — but the live network of attestations and the computed trust scores are the asset competitors cannot copy by running the same code. Network effects compound: every new issuer and attestation strengthens the graph for every provider, because the graph is global.

### 2.5 Tagline wedge

"Trust decisions for agents you've never met."

---

## 3. Decisions locked during brainstorming and review

| Decision | Choice | Rationale |
|---|---|---|
| Productization model | Open-source toolkit + hosted SaaS | Tailscale/Snyk model |
| Primary buyer | Two-sided network | Long-term moat |
| v1 scope | Full control plane + hardened OSS | Both sides onboard from day one |
| Trust graph partitioning | **Global graph; tenant-scoped policy/ownership only** | Canonical scores are network-wide; tenants apply thresholds as a policy overlay |
| Agent canonical identity | **Stable VeriLink ID (`vrl:agent:<uuid>`); public keys attached as `did:key` verification methods** | `did:key` is derived from its key and cannot rotate; a stable ID supports key rotation/history while keys remain `did:key`-expressed |
| Request authentication | **HTTP Message Signatures (RFC 9421) + Content-Digest (RFC 9530)** | Registration proves key control once; every request must prove possession. `key_hash` is derived after verification, never caller-supplied |
| Edge stack (v1) | **Go (the existing edge-verifier), gated on a fresh baseline benchmark** | ROADMAP `VR-002` is marked complete but no benchmark artifact exists in the repo; the first implementation step is to produce one and revisit if it fails |
| Edge stack (post-v1) | Rust rewrite behind FFI parity harness | Only after the harness proves byte-identical fingerprints |
| Control-plane stack | TypeScript (reusing Numera/Whimsy) | Maximal reuse of hardened auth, RBAC, audit, Redis, Postgres, frontend kit |
| Trust-core algorithms | Stay Go, exposed via gRPC | Avoids a third reimplementation of verified trust math |
| Graph cold-start | VeriLink-seeded root of trust | Empty graphs kill adoption |
| Repo structure | Single monorepo | Small team; one CI, one version, atomic releases |
| OIDC provider | **Clerk via OAuth Application + Authorization Code/PKCE + Account Portal, implemented against generic OIDC (`openid-client`)** | Clerk for the hosted product; generic OIDC keeps self-host pluggable. Not the Clerk session SDK |
| Billing | Stripe Billing, fixed-tier subscriptions in v1 | Standard B2B SaaS; reuse Whimsy/Numera patterns. Defer metered billing |
| Docs generator | Docusaurus | Aligns with React/TypeScript skills; versioned docs, MDX, OpenAPI rendering |
| Hosted region | **OCI `ca-toronto-1` (Toronto)** | Co-locates with Whimsy/Codero; single region accepted in Section 14 |
| Static edge binary | Yes | Linux x86_64 and aarch64, `CGO_ENABLED=0`, systemd unit, sample config, checksums, SBOM, signed releases |
| Graph visualization (v1) | Read-only summaries only | Node/edge counts, top issuers. Interactive `@xyflow/react` explorer deferred to post-v1. Path-summary cards removed (require hop/contribution data the v1 engine cuts) |
| Reputation badge | Post-v1 | Marketing surface, not a trust surface |
| Challenge action | Cut from v1 | No format/lifecycle designed. v1 is allow/deny only |
| Bootstrap de-emphasis | **Manual, metric-gated in v1** | ≥3 independent verified organic issuers, ≥80% organic weighted contribution for 30 days, counterfactual removal report, then stepwise weight reduction with rollback. Not automatic |

---

## 4. Architecture

### 4.1 Monorepo layout

```
verilink/
├── pkg/                    # Go — shared trust core (existing, hardened)
│   ├── fingerprint/        # map-based header canonicalization + JA4 + key hash (existing)
│   ├── attestation/        # JWS issue/verify, Ed25519 (existing); v1 adds kid + schema_version
│   ├── trust/              # VeriRank algorithm (existing) + determinism/trust_weight fixes
│   └── verifier/           # trust store interface (existing)
├── cmd/                    # Go binaries
│   ├── trust-engine/       # NEW: gRPC server exposing pkg/* to TS control plane
│   ├── edge-verifier/      # v1 edge (hardened: HTTP Message Signatures, sync client, WAL)
│   ├── attestation-service/# deprecated after TS control plane ships
│   └── keygen/             # kept
├── edge-rs/                # Rust — DEFERRED to post-v1 (parity harness only in v1)
│   └── ffi/                # v1: cbindgen bindings for Go/Rust parity tests only
├── control-plane/          # TS — NEW, adapts Whimsy api/ patterns
│   ├── src/
│   │   ├── db/             # adapt whimsy api/src/db
│   │   ├── middleware/     # adapt: auth (API key + HMAC), oidc, rateLimit, audit
│   │   ├── authz/          # adapt: RBAC
│   │   ├── shared/         # adapt: logger, redis, apiKeyRequestActivity, encryption, openapi
│   │   ├── domains/
│   │   │   ├── tenant/     # onboarding, memberships, quotas
│   │   │   ├── registry/   # agent + issuer registry (global graph)
│   │   │   ├── graph/      # attestation store (global); calls trust-engine gRPC for VeriRank
│   │   │   ├── sync/       # sync event log + snapshot + SSE
│   │   │   ├── bootstrap/  # root-of-truth seeder
│   │   │   ├── policy/     # per-tenant thresholds and actions (overlay)
│   │   │   ├── billing/    # Stripe subscriptions, webhook dedup, entitlements
│   │   │   └── events/     # decision-event ingestion (aggregate + sampled)
│   │   └── index.js
│   ├── migrations/         # SQL migrations (whimsy-style numbered dirs)
│   └── package.json
├── dashboard/              # TS — Vite + Radix + TanStack (Numera/Whimsy kit)
├── client/
│   ├── go/                 # existing Go client + v1 HTTP Message Signature signing
│   ├── node/               # npm-published as @verilink/node, with TS types + signing
│   └── rust/               # deferred with edge-rs
├── deploy/
│   ├── docker/             # Dockerfiles + docker-compose.self-host.yml
│   ├── helm/               # Helm chart (configurable topology)
│   └── systemd/            # verilink-edge.service unit template + sample config
├── docs/                   # Docusaurus site
│   ├── specs/              # versioned facts JSON Schemas (transaction_summary@1, etc.)
│   └── superpowers/specs/  # this document
└── scripts/
    ├── dev-up.sh
    ├── benchmark-baseline.sh   # Go VR-002 baseline — first implementation gate
    └── parity-check.sh         # Go-vs-Rust parity (post-v1 gate for Rust graduation)
```

### 4.2 Deployable components

| Component | Language | Port | Role |
|---|---|---|---|
| `edge-verifier` (v1) | Go | 8080 (data), 9090 (admin) | Reverse proxy. Verifies HTTP Message Signature, derives key hash, resolves canonical identity, looks up local trust cache, allow/deny, proxy to backend. Pulls sync event stream from control plane. |
| `control-plane` | TypeScript (Express) | internal HTTP behind ingress; calls gRPC to trust-engine | Multi-tenant API: agent/issuer registry, attestation submission and verification, sync event log + snapshot, policy, API keys, onboarding, billing webhooks. |
| `trust-engine` | Go (gRPC) | 9091 | Stateless VeriRank runner + attestation JWS verify + fingerprint parity check. |
| `dashboard` | TypeScript (Vite SPA) | served by control-plane | Provider and agent-builder views: read-only graph summaries, agents, attestations, policy editor, API keys, billing. |

Supporting infrastructure: Postgres (durable source of truth), Redis (sync buffer, rebuilt from Postgres after restart; rate-limit counters). The edge runs local-memory only.

**Edge deployment topology is configurable** via the Helm chart's `edge.kind` value: `DaemonSet`, `Deployment`, or a static binary on a VM with the provided systemd unit.

### 4.3 Request authentication protocol (new in v3)

Registration proves key control once. **Every inbound agent request must prove possession of the private key at request time.** VeriLink uses HTTP Message Signatures (RFC 9421) with Content-Digest (RFC 9530) for body integrity.

**Signature inputs:**

- `@method` — the HTTP method
- `@authority` — the host (and port if non-default)
- `@target-uri` — the full request target
- `Content-Digest` — for requests with bodies (RFC 9530, SHA-256)
- `created` — signature creation timestamp
- a bounded validity window: the edge rejects signatures where `created` is more than 5 minutes in the past or any amount in the future (clock skew tolerance: 30s)

**Signature header:**

```http
 Signature: sig1=:<base64>:, sig1
 Signature-Input: sig1=("@method" "@authority" "@target-uri" "content-digest" "created");keyid="<stable-id>#<key-id>";alg="ed25519";created=<unix>
```

`keyid` is `<stable-verilink-id>#<key-id>` — e.g. `vrl:agent:abc123#k1`. The edge resolves the stable ID, looks up the current (or `iat`-valid) public key for `k1`, and verifies the Ed25519 signature.

**Key hash derivation:** `key_hash = sha256(public_key_jwk)`, computed by the edge **after** successful signature verification. A caller-supplied `key_hash` header is ignored — the edge never trusts a claimed key hash.

**Unsigned behavioral aliases:** requests without a valid signature resolve to the `correlated_behavioral` or `unknown` assurance level. Their trust score is **capped at a provider-configurable maximum** (default 25) — they cannot inherit the full `verified_key` score. Providers can opt to deny unsigned requests entirely via policy.

**Client signing support:** the Go and Node clients gain a signing helper that adds `Signature`, `Signature-Input`, and `Content-Digest` headers to outbound requests. The agent's private key is supplied by the caller and never sent to VeriLink.

### 4.4 Identity model

An agent's canonical network identity is a **stable VeriLink identifier**: `vrl:agent:<uuid>` for agents, `vrl:issuer:<uuid>` for issuers. One or more public keys are attached to each identity, each expressed as a `did:key` verification method and identified by a `key_id` (e.g. `k1`, `k2`). This supports key rotation and history while keeping keys `did:key`-expressed.

JWS `iss` and `sub` carry the **stable VeriLink ID**, not the `did:key`. The signing key's `key_id` is carried in the JWS `kid` header. The verifier resolves the key valid at the token's `iat` from `issuer_keys` history.

**Lazy subject creation:** a subject can be attested to before it registers a key. The control plane creates the subject with `vrl:agent:<uuid>`, no public key, and assurance level `unknown`. A later verified registration attaches a key and upgrades assurance to `verified_key`. This supports the "agents the network hasn't met yet" premise — attest-then-register works, not just register-then-attest.

**Observed fingerprints** (JA4 + canonicalized headers + key hash) are aliases, correlated to the stable ID, with an assurance level:

- `verified_key` — the request carried a valid HTTP Message Signature for a registered key.
- `correlated_behavioral` — a fingerprint was observed (unsigned or signed but unregistered) and correlated to a registered agent by key hash match.
- `unknown` — no correlation. The fingerprint is not stored as an alias row; it resolves to score 0 at decision time (see 7.1).

**Alias resolution rule:** a fingerprint that matches exactly one `verified_key` agent resolves to that agent. A fingerprint that matches multiple agents, or matches only `correlated_behavioral` agents, resolves to `unknown` — only `verified_key` assurance can carry trust. This closes the adversarial collision vector (a malicious agent mimicking a trusted agent's header fingerprint gets `unknown`, not the victim's score).

### 4.5 Data flow

**Attestation ingest:**

1. A counterparty observes an agent's behavior and signs a JWS attestation (`iss` = issuer's `vrl:issuer:<uuid>`, `sub` = subject's `vrl:agent:<uuid>`, `kid` = signing key id, `vli.schema_version`, `vli.type`, `vli.facts`, `vli.visibility`, `vli.trust_level_delta`).
2. The counterparty's service calls `control-plane POST /v1/attestations/submit` with the signed JWS.
3. The control plane **pre-parses the unverified JWS** to read `iss` and `iat` (the JWT header and payload are base64url-decodable without verification). It resolves the issuer's **candidate public keys** from `issuer_keys` valid at `iat` and not revoked. If multiple keys are valid, it tries each (or passes a repeated list to the engine — see 4.6). Unknown `iss`: reject 4xx and audit.
4. **Synchronous** signature verification via `trust-engine.VerifyAttestation` (caller supplies candidate public keys). **Synchronous** schema validation against the versioned facts schema for `vli.type@vli.schema_version`. **Synchronous** dedup check on `token_digest` (sha256 of the JWS, `UNIQUE NOT NULL`). Invalid attestations receive a **deterministic 4xx**.
5. On success: the subject is lazily created if it doesn't exist (no key, `unknown` assurance). The attestation is stored transactionally. A `RunVeriRank` job is enqueued for the network (debounced, one run per minute).

**Score computation:**

1. The control plane loads the **active, non-superseded** global attestation set from Postgres, filtered to attestations younger than ~4 half-lives (720 days; older ones contribute ≈0 to VeriRank). This caps the per-run gRPC payload size.
2. It calls `trust-engine.RunVeriRank` with the attestation set, the global issuer list (with `trust_weight` and `is_bootstrap`), the bootstrap root IDs, and an **explicit `evaluation_time`**. The request is **chunked via client streaming** to stay within gRPC message limits (see 4.6).
3. The engine runs VeriRank (max 4 hops, distance decay `0.8^d`, time decay `e^(-λt)`, half-life 180 days — matching `TimeDecayHalfLifeDays = 180.0`). Roots initialize at 100 (the current engine behavior; `seed_score` is removed from the contract). Output is keyed by stable VeriLink ID.
4. The control plane writes results to `network_scores` (durable) and `network_score_history` (only on score change, to bound growth). It appends `score.upsert` / `score.delete` events to the **sync event log** (see 4.7). `sync_version` advances.

**Edge sync (versioned contract, unified sync_version):**

1. `edge-verifier` boots with a tenant API key over TLS.
2. It fetches a **full snapshot**: `GET /v1/sync/snapshot` returns a versioned, compressed payload containing the global score table, the alias map (fingerprint → stable ID, assurance level), and this tenant's active policy. The edge replaces its in-memory snapshot **atomically** (immutable map swap).
3. Subsequent updates arrive as **SSE events** from a **unified sync event log** keyed by a monotonic `sync_version`. Event types: `score.upsert`, `score.delete`, `alias.upsert`, `alias.delete`, `key.revoke`, `policy.replace`, `heartbeat`. The edge applies events in order. If its `Last-Event-ID` is expired (the control plane has pruned beyond that version), the SSE response is `410 Gone` → fetch a new full snapshot.
4. The control plane sends a **heartbeat event every 30 seconds** regardless of score changes. Freshness is measured from the last successfully authenticated heartbeat/contact, not from the last score change (see 7.1).
5. The edge persists each snapshot to disk **atomically** (`snapshot.json.tmp` → `rename`).
6. Postgres is the durable truth; Redis is rebuilt from Postgres after a restart.

**Allow/deny decision:**

1. An inbound agent request hits `edge-verifier` on port 8080.
2. The edge verifies the HTTP Message Signature (4.3). If invalid or absent → unsigned handling (capped score or deny per policy).
3. The edge derives `key_hash` from the verified public key, computes the observed fingerprint (`pkg/fingerprint`: `map[string]string` headers → `headers_hash`, plus JA4, protocol, key hash).
4. It resolves the fingerprint to a stable ID via the alias map (4.4 resolution rule). **Unknown fingerprint** → score 0, `score_reason: unknown`.
5. It looks up the network score. `blacklisted` and `score_reason` are read from the score row (not inferred from 0 — see 4.6).
6. Per the tenant's policy: `allow` (proxy, `X-Verilink-Status: Allowed`) or `deny` (403, `X-Verilink-Status: Denied`). No `challenge` in v1.
7. The decision is written to a **bounded local WAL** and flushed in batches to the control plane's `events/` domain. **When the WAL is full, the edge drops the oldest events and increments a `decisions_dropped_total` counter** — it does **not** block the data path (see 7.2).

### 4.6 Trust-engine gRPC contract

Corrected: stable IDs (not `did:key`), client-streaming input, `blacklisted` + `score_reason` output, raw JSON facts (not string-coerced), candidate keys list for verification.

```proto
service TrustEngine {
  rpc RunVeriRank(stream RunChunk) returns (ScoreTable);
  rpc VerifyAttestation(VerifyRequest) returns (VerifyResult);
  rpc Fingerprint(FingerprintRequest) returns (Fingerprint);
}

// RunVeriRank: client-streamed input to stay within message limits.
// First chunk carries the run metadata; subsequent chunks carry attestations/issuers.
message RunChunk {
  oneof payload {
    RunHeader header = 1;
    Attestation attestation = 2;
    Issuer issuer = 3;
  }
}
message RunHeader {
  repeated string root_ids = 1;        // bootstrap root stable IDs
  int64 evaluation_time_unix = 2;      // REQUIRED — engine must not call time.Now()
}
message Attestation {
  string issuer_id = 1;                // vrl:issuer:<uuid>
  string subject_id = 2;               // vrl:agent:<uuid>
  int32 trust_delta = 3;
  int64 issued_at_unix = 4;
  int64 expires_at_unix = 5;
  string attestation_type = 6;         // transaction_summary | kyb | security_audit | negative_incident | behavioral
}
message Issuer {
  string issuer_id = 1;
  double trust_weight = 2;             // applied as a multiplier on contributions
  bool is_bootstrap = 3;
}

// Output: score + blacklisted + score_reason. confidence/hop_count remain cut.
message ScoreTable {
  repeated ScoreRow rows = 1;
  int64 computed_at_unix = 2;
}
message ScoreRow {
  string subject_id = 1;               // stable VeriLink ID (agent or issuer)
  string entity_kind = 2;              // agent | issuer — issuers are scored too (roots start at 100)
  int32 score = 3;                     // 0..100
  bool blacklisted = 4;               // true only when a negative_incident from a score≥80 issuer zeroed this subject
  string score_reason = 5;            // verified | propagated | unknown | blacklisted | expired
}

// VerifyAttestation: caller supplies candidate keys valid at iat.
message VerifyRequest {
  string jws_token = 1;
  repeated bytes issuer_public_keys = 2;  // Ed25519 public keys valid at iat, not revoked
}
message VerifyResult {
  bool valid = 1;
  string issuer_id = 2;
  string subject_id = 3;
  AttestationPayload payload = 4;
  string error = 5;
}
message AttestationPayload {
  string attestation_type = 1;
  bytes facts_json = 2;               // raw verified JSON bytes — NOT string-coerced
  int32 trust_level_delta = 3;
  int64 issued_at_unix = 4;
  int64 expires_at_unix = 5;
  string jti = 6;
  string schema_version = 7;
  string visibility = 8;              // participants | public
}

// Fingerprint: matches pkg/fingerprint.Generate exactly.
message FingerprintRequest {
  string ja4 = 1;
  map<string, string> headers = 2;
  string key_hash = 3;
  string protocol = 4;
}
message Fingerprint { string sha256 = 1; }
```

**Engine work required for v1:**

1. **Determinism fix:** replace `time.Now()` in `addAttestationLocked` and `calculateTimeDecay` with the supplied `evaluation_time`.
2. **`trust_weight` application:** apply each issuer's `trust_weight` as a multiplier on its contributions. New property-based tests.
3. **`blacklisted` + `score_reason` output:** the engine already applies blacklist overrides (zeroing the score when a negative incident comes from an issuer with score ≥ `BlacklistIssuerThreshold = 80`). Expose this as a `blacklisted` boolean and a `score_reason` enum so the control plane doesn't infer from `score == 0` (which also means unknown/unrooted/expired).
4. **`entity_kind` + issuer scoring:** VeriRank scores every node, including issuers (roots start at 100). The output includes issuer scores so the dashboard and moderation queue can show why a blacklist fired. `network_scores` is keyed by `subject_id` with an `entity_kind` column (no FK to `agents`).
5. **`seed_score` removed:** the engine initializes all roots at 100. The contract does not carry `seed_score`; bootstrap roots get `is_bootstrap = true` and the standard 100 initialization. (Stepwise de-emphasis reduces `trust_weight`, not the initial score — see 6.1.)
6. **Max-path vs. weighted-average:** the engine currently takes the maximum trust path (`engine.go:160`). The `trust_graph.md` spec says weighted average. **v1 locks the tested max-path algorithm** and documents this divergence; consensus redesign is deferred. The spec doc is updated to match.

### 4.7 Sync event log (new in v3)

A single durable, monotonic event log drives edge sync. One `sync_version` covers scores, aliases, keys, and policies — not just score changes.

```sql
sync_events (
  sync_version    bigserial pk,
  event_type      text not null,        -- score.upsert | score.delete | alias.upsert | alias.delete | key.revoke | policy.replace | heartbeat
  subject_id      text,                 -- for score/alias events
  tenant_id       uuid,                 -- for policy.replace
  payload         jsonb not null,       -- event-specific
  created_at      timestamptz not null default now()
);
```

The snapshot endpoint reads the current state as of the latest `sync_version`. The SSE stream replays events from the edge's `Last-Event-ID` forward. The control plane prunes events older than a retention window (default 24h); a request for a pruned version returns `410 Gone`.

### 4.8 Reused vs. adapted (delta from Whimsy)

| Whimsy module | VeriLink use | Adaptation |
|---|---|---|
| `api/src/db/{client,migrate,transaction}.js` | Adapt | New schema; same Pool/migrate patterns |
| `api/src/middleware/auth.js` | **Substantial adaptation** | Drop Firebase, add OIDC (Clerk OAuth + PKCE), `vrl_` key format, membership resolution, tenant-billing gating. HMAC-SHA256 key hashing ports cleanly. |
| `api/src/middleware/{rateLimit,audit}.js` | Adapt | Per-tenant quotas; audit schema differs |
| `api/src/authz/` | Adapt | VeriLink resources; global-vs-tenant resource distinction |
| `api/src/shared/{logger,redis,apiKeyRequestActivity,encryption,openapi}.js` | Adapt | New key patterns; new audit actions |
| `app/` kit | Fork as scaffold | VeriLink views; read-only graph summaries |
| `api/src/domains/billing/*` | Adapt | Reuse checkout/portal/webhook; persist webhook IDs |

### 4.9 Whimsy and Codero as reference customers

**Whimsy** is the first seeded issuer. Its `shared/verilink.js` module already submits `behavioral` attestations. Post-productization it points at the hosted control plane. Two compatibility fixes (Section 6.3): add `behavioral` to the enum, and dedup on `token_digest` (not `jti`). Whimsy's `remoteFingerprint` (a hash of `userId:remoteId:provider`) means Whimsy attests about storage remotes, not autonomous agents — it proves the issuer loop, not the provider-side agent-identification loop.

**Codero** is the second reference customer, proving the provider loop. A dedicated VeriLink-guarded listener is placed in front of a narrow agent-ingest endpoint (`POST /memory/observations`). An OpenCode/Codex session signs requests using the new HTTP-signature protocol. VeriLink is **not** placed in front of the entire Codero dashboard API — only the agent-write surface. This exercises the full provider loop (signature verification → key hash → identity resolution → score → allow/deny) with zero external dependency and gives a credible "VeriLink protects itself" launch story alongside the Codero example.

---

## 5. Data model

Postgres. The schema is presented as a **logical schema** — the executable DDL is generated by the Whimsy-style migration runner. The graph is **global**; tenants own policies, API keys, memberships, edge nodes, and billing. Isolation is **application-level** in v1 (the ported `authz/` layer injects `WHERE tenant_id = $1` on tenant-scoped tables). Tenant-scoped cross-references use **composite tenant-safe foreign keys**.

### 5.1 Global graph tables

```sql
-- Canonical agent identities (network-wide)
agents (
  id              text pk,                  -- vrl:agent:<uuid>
  name            text,
  owner_tenant_id uuid references tenants(id),
  assurance_level text not null default 'unknown',  -- unknown | correlated_behavioral | verified_key
  metadata        jsonb default '{}',
  first_seen_at   timestamptz not null default now(),
  last_seen_at    timestamptz not null default now(),
  status          text not null default 'active',   -- active | deactivated
  deactivated_at  timestamptz
);
-- agents has no public_key_jwk column. Keys live in agent_keys (below), supporting rotation.
-- assurance_level is upgraded to verified_key when a key is attached and proven.

-- Agent keys (rotation/history)
agent_keys (
  id              text not null,            -- key id, e.g. k1
  agent_id        text not null references agents(id),
  public_key_jwk  jsonb not null,           -- expressed as a did:key verification method
  valid_from      timestamptz not null default now(),
  valid_until     timestamptz,              -- null = current
  revoked_at      timestamptz,
  revocation_reason text,
  primary key (agent_id, id)
);

-- Observed fingerprints correlated to canonical agents (aliases)
-- Only correlated fingerprints are stored. Unknown fingerprints are NOT alias rows.
agent_fingerprints (
  fingerprint     text primary key,         -- one fingerprint → at most one agent (see resolution rule 4.4)
  agent_id        text not null references agents(id),
  assurance_level text not null,            -- verified_key | correlated_behavioral (never 'unknown')
  first_seen_at   timestamptz not null default now(),
  last_seen_at    timestamptz not null default now()
);
-- If a fingerprint would match multiple agents, it is not stored; it resolves to unknown at decision time.

-- Issuers: entities that sign attestations (global)
issuers (
  id              text pk,                  -- vrl:issuer:<uuid>
  name            text not null,
  owner_tenant_id uuid references tenants(id),  -- the tenant that owns this issuer (for dashboard access, private-facts authz)
  trust_weight    numeric(3,2) default 1.0,
  is_bootstrap    boolean default false,    -- derived from bootstrap_registry by the seeder
  verified_at     timestamptz,
  created_at      timestamptz not null default now()
);

-- Issuer keys (rotation/history)
issuer_keys (
  id              text not null,            -- key id, e.g. k1
  issuer_id       text not null references issuers(id),
  public_key_jwk  jsonb not null,           -- expressed as a did:key verification method
  valid_from      timestamptz not null default now(),
  valid_until     timestamptz,              -- null = current
  revoked_at      timestamptz,
  revocation_reason text,
  primary key (issuer_id, id)
);

-- Attestations: signed behavioral reports (global)
attestations (
  id              uuid pk,
  issuer_id       text not null references issuers(id),
  subject_id      text not null references agents(id),
  jws_token       text not null,
  token_digest    text not null unique,     -- sha256(jws_token); dedup (NOT NULL UNIQUE)
  payload         jsonb not null,
  facts           jsonb not null,           -- shareable facts
  facts_private   jsonb,                    -- issuer/subject/staff only (see visibility)
  visibility      text not null default 'participants',  -- participants | public
  trust_delta     integer not null,
  attestation_type text not null,           -- transaction_summary | kyb | security_audit | negative_incident | behavioral
  schema_version  text not null,            -- e.g. "1"; versioned facts schema
  jti             text,                     -- advisory; may be null
  issued_at       timestamptz not null,
  expires_at      timestamptz,
  superseded_by   uuid references attestations(id),
  sig_verified    boolean not null default true,
  received_at     timestamptz not null default now()
);

-- Network scores: materialized VeriRank output (global, canonical)
-- Keyed by subject_id (stable VeriLink ID), with entity_kind so issuers are scored too.
network_scores (
  subject_id      text primary key,         -- vrl:agent:<uuid> or vrl:issuer:<uuid>
  entity_kind     text not null,            -- agent | issuer
  score           integer not null,         -- 0..100
  blacklisted     boolean not null default false,
  score_reason    text not null,            -- verified | propagated | unknown | blacklisted | expired
  computed_at     timestamptz not null default now(),
  sync_version    bigint not null           -- the sync event log version this score was written at
);
-- No FK to agents(id) — issuers are scored too.

-- Score history: one row per subject per score CHANGE (not per run)
network_score_history (
  subject_id      text not null,
  score           integer not null,
  blacklisted     boolean not null,
  score_reason    text not null,
  computed_at     timestamptz not null,
  sync_version    bigint not null,
  primary key (subject_id, sync_version)
);

-- Sync event log (unified, monotonic) — see 4.7
sync_events (
  sync_version    bigserial pk,
  event_type      text not null,
  subject_id      text,
  tenant_id       uuid,
  payload         jsonb not null,
  created_at      timestamptz not null default now()
);

-- Bootstrap registry: VeriLink-seeded root of trust
-- Split into typed tables to avoid the invalid "REFERENCES issuers OR agents" SQL.
bootstrap_agents (
  agent_id        text primary key references agents(id),
  name            text not null,
  seeded_at       timestamptz not null default now(),
  current_weight  numeric(3,2) not null default 1.0,  -- stepwise-reduced during de-emphasis
  de_emphasized_at timestamptz,
  de_emphasis_reason text,
  approved_by     uuid references users(id)            -- staff who approved the step
);
bootstrap_issuers (
  issuer_id       text primary key references issuers(id),
  name            text not null,
  seeded_at       timestamptz not null default now(),
  current_weight  numeric(3,2) not null default 1.0,
  de_emphasized_at timestamptz,
  de_emphasis_reason text,
  approved_by     uuid references users(id)
);
-- is_bootstrap on issuers/agents is derived by the seeder from these tables. No hand-maintained column.
```

### 5.2 Tenant-scoped tables

```sql
tenants (
  id           uuid pk,
  slug         text unique not null,
  name         text not null,
  plan         text not null default 'free',
  status       text not null default 'active',
  created_at   timestamptz not null default now()
);

-- Global users (a developer may belong to multiple tenants)
users (
  id           uuid pk,
  email        citext unique not null,
  oidc_issuer  text not null,            -- Clerk issuer URL
  oidc_subject text not null,            -- OIDC sub
  created_at   timestamptz not null default now(),
  unique (oidc_issuer, oidc_subject)
);

-- Tenant memberships (junction)
tenant_memberships (
  user_id      uuid not null references users(id),
  tenant_id    uuid not null references tenants(id),
  role         text not null default 'member',  -- owner | admin | member
  created_at   timestamptz not null default now(),
  primary key (user_id, tenant_id)
);

-- API keys — HMAC-SHA256
api_keys (
  id              uuid pk,
  tenant_id       uuid not null references tenants(id),
  key_prefix      text not null,
  key_hash_hmac   text not null,           -- HMAC-SHA256 keyed by API_KEY_HMAC_SECRET
  scopes          text[] not null,
  last_used_at    timestamptz,
  created_at      timestamptz not null default now(),
  revoked_at      timestamptz
);
-- Format: vrl_ + exactly 64 lowercase hex chars. Regex: /^vrl_[0-9a-f]{64}$/.

-- Policies: per-tenant threshold + below-threshold action (overlay on global scores)
policies (
  id              uuid pk,
  tenant_id       uuid not null references tenants(id),
  name            text not null,
  threshold       integer not null default 50,
  below_threshold_action text not null default 'deny',  -- allow | deny (renamed from "action")
  allow_fingerprints text[] default '{}',   -- exact-match allow list (precedence over threshold)
  deny_fingerprints text[] default '{}',    -- exact-match deny list (precedence over threshold and over score)
  unsigned_max_score integer default 25,    -- cap for unsigned/correlated_behavioral requests; set 0 to deny all unsigned
  is_active       boolean not null default true,
  created_at      timestamptz not null default now(),
  unique (tenant_id, name)
  -- only one active policy per tenant:
  -- partial unique index active_policy_per_tenant on (tenant_id) where is_active
);

-- Edge nodes (per tenant). PK is id; composite unique (tenant_id, id) for tenant-safe FKs.
edge_nodes (
  id              uuid pk,                 -- also serves as the WAL source-id
  tenant_id       uuid not null references tenants(id),
  name            text not null,
  api_key_id      uuid references api_keys(id),
  last_seen_at    timestamptz,
  last_sync_version bigint,
  status          text not null default 'unknown',
  created_at      timestamptz not null default now(),
  unique (tenant_id, id)                   -- composite for tenant-safe FK target
);

-- Sync cursors (per tenant + edge node). Composite FK to edge_nodes(tenant_id, id).
sync_cursors (
  tenant_id       uuid not null,
  edge_node_id    uuid not null,
  last_cursor     bigint not null default 0,   -- sync_version
  last_sync_at    timestamptz,
  snapshot_hash   text,
  primary key (tenant_id, edge_node_id),
  foreign key (tenant_id, edge_node_id) references edge_nodes(tenant_id, id)
);

-- Subscriptions (Stripe)
subscriptions (
  id              uuid pk,
  tenant_id       uuid not null references tenants(id),
  stripe_customer_id   text not null,
  stripe_subscription_id text not null,
  plan            text not null,
  status          text not null,
  current_period_end timestamptz,
  created_at      timestamptz not null default now()
);

-- Stripe webhook event dedup (global table, moved under global heading in executable DDL)
stripe_webhook_events (
  id              text pk,                 -- Stripe event id
  received_at     timestamptz not null default now(),
  processed_at    timestamptz,
  payload         jsonb not null
);

-- Decision events: aggregate + sampled raw (NOT every decision at line rate)
-- Per-minute aggregates
decision_aggregates (
  id              bigserial pk,
  tenant_id       uuid not null references tenants(id),
  edge_node_id    uuid not null,
  bucket_minute   timestamptz not null,
  fingerprint     text,                    -- nullable for "all" rollup
  resolved_id     text,                    -- nullable for unknown
  action          text not null,           -- allow | deny
  count           integer not null,
  primary key (tenant_id, edge_node_id, bucket_minute, action)
);
-- Sampled raw events (all denies + tunable % of allows)
decision_samples (
  id              bigserial pk,
  tenant_id       uuid not null references tenants(id),
  edge_node_id    uuid not null,
  wal_seq         bigint not null,         -- per-edge monotonic WAL sequence (dedup key)
  fingerprint     text not null,
  resolved_id     text,
  score           integer,
  blacklisted     boolean,
  score_reason    text,
  action          text not null,
  decided_at      timestamptz not null,
  received_at     timestamptz not null default now(),
  unique (edge_node_id, wal_seq)           -- dedup
);

-- Audit log: administrative/state-change events only (low volume)
audit_log (
  id              bigserial pk,
  tenant_id       uuid not null references tenants(id),
  actor_type      text not null,
  actor_id        text,
  action          text not null,
  resource        text not null,
  resource_id     text,
  metadata        jsonb default '{}',
  ip              text,
  user_agent      text,
  created_at      timestamptz not null default now()
);
```

### 5.3 Tenant isolation

**Application-level** in v1. The ported `authz/` layer injects `WHERE tenant_id = $1` on tenant-scoped tables. Global graph tables are cross-tenant by design. Tenant-scoped cross-references use composite FKs: `sync_cursors.(tenant_id, edge_node_id) → edge_nodes.(tenant_id, id)`. `decision_samples` and `decision_aggregates` carry `tenant_id` and `edge_node_id` and are filtered by `tenant_id` at the authz layer.

### 5.4 Multi-tenancy model

Row-level isolation, shared schema. Self-hosted = single tenant. Enterprise = own self-hosted deployment. One code path.

### 5.5 Data retention and privacy

Attestation `facts` and `facts_private` may carry personal data. v1 policy:

- **Retention:** attestations are retained until the later of (a) the attestation's `expires_at` and (b) the issuing issuer's deactivation date + 1 year. After that, attestations are deleted (not tombstoned).
- **Subject deletion request:** the subject agent is **deactivated** (`status = 'deactivated'`, `deactivated_at = now()`). It is removed from active scoring (excluded from VeriRank runs). Ownership and display metadata (`name`, `metadata`) are cleared. The cryptographic record (the agent row and its attestations) is preserved or deleted **according to an explicit legal basis and retention policy** — not merely relabeled. Combining multiple subjects into a tombstone is explicitly avoided (it would damage graph integrity).
- **`/v1/privacy/export` and `/v1/privacy/delete`** endpoints are in scope for v1 as **workflow initiators**, not as automatic compliance guarantees. **Privacy counsel must validate the retention and erasure model** before the hosted product processes personal data. The endpoints are a tool, not a compliance certification.
- **`facts`/`facts_private` never written to logs.** Redaction applies at every egress: API responses, dashboard, exports. `facts_private` is visible only to the issuer's owner tenant, the subject's owner tenant, and VeriLink staff.
- **`visibility: participants | public`** is attestation-level (no field-level mixed visibility in v1). If an issuer needs some facts public and some private, it issues two attestations.
- Decision aggregates: retained 90 days (pro) / 1 year (enterprise). Decision samples: retained 30 days (pro) / 90 days (enterprise). Audit log: 90 days (pro) / 1 year (enterprise).

---

## 6. Security

| Concern | Measure |
|---|---|
| **Request authentication** | HTTP Message Signatures (RFC 9421) + Content-Digest (RFC 9530). `key_hash` derived after verification; caller-supplied key hashes are ignored. Unsigned requests are capped or denied per policy. |
| **Signature verification (attestations)** | Ed25519. The control plane pre-parses the JWS for `iss`/`iat`, resolves candidate keys from `issuer_keys` valid at `iat` and not revoked, and supplies them to `trust-engine.VerifyAttestation`. Key rotation does not break historical attestation verification. |
| **API key storage** | HMAC-SHA256 keyed by `API_KEY_HMAC_SECRET` (≥16 chars). Raw keys never persisted. No legacy column. |
| **API key format** | `vrl_` + exactly 64 lowercase hex chars. Regex `/^vrl_[0-9a-f]{64}$/`. Extraction via `Authorization: Bearer` or `X-API-Key`. |
| **Tenant isolation** | Application-level: `authz/` layer injects `WHERE tenant_id = $1` on tenant-scoped tables. Global graph tables are cross-tenant by design. |
| **RBAC scopes** | `attest:write`, `attest:read`, `sync:read`, `policy:admin`, `tenant:admin`, `billing:read`. |
| **Rate limiting** | Per-tenant quotas by plan. Edge sync (snapshot + SSE) exempt from request rate limits. |
| **Edge to control-plane auth** | Tenant API key over TLS in v1. mTLS deferred. |
| **Customer private keys** | **Never enter VeriLink.** Only public keys are stored. The only private key VeriLink holds is its own bootstrap signing key, in KMS/HSM. |
| **Audit** | `audit_log` for state-changing administrative events. Edge decisions → `decision_aggregates` + `decision_samples` (aggregate + sampled, not line-rate). |
| **Replay protection** | Attestations carry `iat`/`exp`. Dedup on `token_digest` (sha256 of JWS, NOT NULL UNIQUE). `jti` advisory. |
| **Fail-closed edge** | Unknown fingerprint → score 0, policy default. Degraded (sync stale beyond `MAX_SNAPSHOT_AGE`) → 503. |

### 6.1 Abuse and Sybil resistance

VeriRank propagates trust **only from roots of trust**. An attacker minting sock-puppet issuers gets **zero score** — the puppet cluster is unrooted. This is already true in `pkg/trust/engine.go`.

- **Issuer verification:** `issuers.verified_at` is set after proof of key control (sign a challenge) and, for higher `trust_weight`, manual review. Unverified issuers default to `trust_weight = 0`.
- **Agent ownership proof:** registration requires signing a challenge with the agent's private key.
- **Attestation taxonomy + schema validation:** the control plane validates `attestation_type` against the enum and `facts` against the versioned per-type JSON Schema (Section 6.4) before storing. Unknown types or schema versions → 4xx.
- **Negative-report dispute/moderation:** a `negative_incident` from an issuer with score ≥ 80 (`BlacklistIssuerThreshold`) zeroes the subject's score (`blacklisted = true`). The subject may file a dispute (moderation queue); disputes flag for staff review, no auto-revoke.
- **Issuer/key revocation:** `issuer_keys.revoked_at` + `revocation_reason`; revoked keys fail verification. An issuer is deactivated by revoking all keys. A `key.revoke` sync event propagates to all edges.
- **Attestation retraction/supersession:** `attestations.superseded_by` chains retractions; a superseding attestation replaces the old in the next VeriRank run.
- **Visibility:** `facts_private` visible only to issuer-owner, subject-owner, and staff. `visibility: participants | public` is attestation-level.

### 6.2 JA4 and TLS termination

- **Edge terminates TLS:** full JA4 available.
- **Edge behind an existing LB or Cloudflare:** JA4 unavailable. Fingerprint collapses to `headers_hash + key_hash + protocol`. Edge sets `X-Verilink-Fingerprint-Mode: full | degraded`.
- **Identity continuity:** `key_hash` is the durable anchor, derived from the verified signature. A UA version bump changes `headers_hash` but reputation is not reset as long as the key hash matches a registered agent.

### 6.3 Whimsy compatibility (migration required)

1. **`type: "behavioral"`** added to the enum.
2. **No `jti`** in Whimsy's current payload → dedup on `token_digest`. Whimsy's tokens dedup correctly without modification.
3. **`schema_version`:** Whimsy's existing payload has no `vli.schema_version`. The control plane defaults absent `schema_version` to `"0"` and validates `behavioral@0` as exactly what Whimsy sends today. A future Whimsy update adds `schema_version: "1"`.
4. **`visibility`:** Whimsy's payload has no `visibility` field. Default `"participants"`.
5. **`iss`/`sub` DID form:** Whimsy uses `did:key:whimsy-system` and a `remoteFingerprint` hash as `sub`. These are not `vrl:` IDs. The control plane accepts legacy `did:key` and opaque subject strings on ingest, creates `vrl:agent:<uuid>` / `vrl:issuer:<uuid>` records lazily, and records the original DID/string in `metadata.legacy_did`. New attestations use `vrl:` IDs.

### 6.4 Per-type facts schemas

Versioned JSON Schemas in `docs/specs/`, required before ingest. `vli.schema_version` is mandatory; unknown versions → 4xx. `additionalProperties: false` for typed schemas. Maximum serialized size: 8 KB. Maximum depth: 4.

- `transaction_summary@1`: observation window (start, end), success count, failure count, dispute count.
- `kyb@1`: status, verifier, jurisdiction, verification timestamp, expiry timestamp.
- `security_audit@1`: standard, result, auditor, report digest, audit timestamp.
- `negative_incident@1`: category, severity, occurrence timestamp, evidence digest.
- `behavioral@0`: exactly what Whimsy sends today (`{ action, ... }`, `additionalProperties: true`, no required fields). `behavioral@1` (future): schema URI, observation timestamp, bounded issuer-defined data.

Facts never feed VeriRank — only `trust_delta` does. The schemas are hygiene, not math.

---

## 7. Error handling

### 7.1 Edge (`edge-verifier`, Go)

Three distinct states, not conflated:

| State | Definition | Behavior |
|---|---|---|
| **Unknown fingerprint** | Not in the current snapshot's alias map | Score 0, `score_reason: unknown`, policy default action. The **common case**, not an error. |
| **Degraded (sync stale)** | Time since last authenticated SSE heartbeat > `MAX_SNAPSHOT_AGE` (default 5 min, tunable 1–30 min per tenant) | 503, `X-Verilink-Mode: stale`. The edge does not serve a snapshot older than the max age. |
| **Degraded (sync unreachable, contact fresh)** | Sync API unreachable, last heartbeat within `MAX_SNAPSHOT_AGE` | Serve the snapshot, `X-Verilink-Mode: degraded`. Retry sync (1s → 30s backoff). Surface `stale` to the control plane. |

Freshness is **time since last authenticated heartbeat/contact** (heartbeats every 30s), not time since last score change. A quiet network does not make a healthy edge look stale.

The in-memory snapshot is an **immutable map** (atomic swap), not an LRU. A cache miss means "unknown" (state 1), never "fall back to an older snapshot."

**Opt-in fail-open:** availability-sensitive tenants may set `policy.fail_open_expired = true`, which serves `X-Verilink-Mode: expired` and proxies anyway when the snapshot is stale, rather than 503. Default is fail-closed.

### 7.2 Control plane (`control-plane` TS)

Whimsy-style structured errors. Attestation ingest: signature + schema verified **synchronously**; storage transactional; only score recomputation enqueued. Invalid → deterministic 4xx. `RunVeriRank` failures retry 3x then dead-letter; `network_scores` stays at last-good; dashboard shows staleness warning after 1h.

**Decision-event ingestion** is decoupled from the data path. The edge writes decisions to a bounded local WAL with a per-node monotonic `wal_seq`. It flushes in batches to the control plane. **When the WAL is full, the edge drops the oldest events and increments `decisions_dropped_total`** (a Prometheus counter that is itself reported and alerted on). It does **not** block the data path — a telemetry-ingest outage must not become a customer-API outage. `MAX_SNAPSHOT_AGE` fail-closed already bounds how long an edge can run disconnected, bounding the unrecorded-decision window. Enterprise tenants may opt into a no-drop mode (`policy.no_drop_decisions = true`) that does block when the WAL fills; this is not the default.

**Sampling policy:** the edge sends per-minute aggregates (tenant, fingerprint-or-ID, action, count) for all decisions, plus sampled raw events: **all denies + 1% of allows** (tunable per tenant). This matches what the dashboard displays (aggregated counters + sampled feed).

### 7.3 Trust engine (`trust-engine` Go)

Stateless gRPC. `RunVeriRank` is idempotent given the same inputs + `evaluation_time`. Panics caught at the handler boundary; goroutine survives.

### 7.4 Failure notifications

Sentry + Prometheus/Alertmanager for service failures. `decisions_dropped_total` is an alert. No n8n error-workflow (that pattern applies to n8n workflow executions, not an Express service).

---

## 8. Observability

| Signal | Source | Tool |
|---|---|---|
| **Metrics** | `edge-verifier` (local decision overhead histogram — excluding upstream service time; allow/deny counter; cache hit rate; WAL depth; `decisions_dropped_total`; SSE heartbeat age), `control-plane` (req rate, VeriRank duration, sync lag, decision ingest lag), `trust-engine` (gRPC duration, verify failures) | Prometheus + Grafana |
| **Logs** | Structured JSON. **`facts`/`facts_private` never written to logs.** | Loki or CloudWatch |
| **Traces** | OpenTelemetry across all three languages. | OTLP → Tempo/Jaeger |
| **Error tracking** | Sentry. | Sentry |
| **Internal dashboards** | Graph size, VeriRank lag, edge health, tenant signups, `decisions_dropped_total`. | Grafana |
| **Tenant dashboards** | Aggregated allow/deny counters + sampled feed; agent score history. | Product dashboard (recharts) |
| **Healthchecks** | `/healthz` on all three services. | K8s probes |

---

## 9. Testing

| Layer | Approach |
|---|---|
| **Go core (`pkg/*`)** | Existing tests + property-based tests for VeriRank (decay invariants, monotonicity, unrooted-cluster zero-score, `trust_weight` application, `evaluation_time` determinism). gRPC contract tests for `cmd/trust-engine`. |
| **Go edge (`cmd/edge-verifier`)** | Integration: mock backend, signed + unsigned + unknown requests, assert status + headers. **`VR-002` latency benchmark is a dedicated-hardware nightly-staging gate**, measuring local decision overhead only. **The first implementation step is a Go baseline benchmark** (`scripts/benchmark-baseline.sh`) — if it doesn't meet 10k req/s at <1ms p99, revisit the edge decision. |
| **TS control plane** | Jest. Unit tests for adapted modules. Integration tests against real Postgres + Redis. Contract tests against gRPC trust engine. |
| **TS dashboard** | Vitest + Playwright. Golden path: onboard, register agent, submit attestation, see score, configure policy. |
| **Cross-language parity (post-v1)** | `scripts/parity-check.sh`: fixture corpus + Go-reference golden hashes committed and locked in CI. Rust must match them to graduate post-v1. **v1 has no cross-language parity criterion** — a one-language reference is not parity. |
| **Load** | k6 against `edge-verifier`, nightly in staging. |
| **Security** | `semgrep` on TS and Go. Secret scan pre-commit. |

---

## 10. Deployment

### 10.1 Artifacts

- `docker/Dockerfile.edge` — Go, multi-stage, distroless, `CGO_ENABLED=0`.
- `docker/Dockerfile.control-plane` — TypeScript, multi-stage.
- `docker/Dockerfile.trust-engine` — Go, multi-stage, distroless.
- `docker/docker-compose.self-host.yml` — all three + Postgres + Redis.
- `helm/` — configurable topology (`edge.kind`: DaemonSet | Deployment). Control-plane + trust-engine as Deployments with HPAs. Postgres + Redis via upstream charts.
- `systemd/verilink-edge.service` — unit template + sample config.
- **Static binary releases:** Linux x86_64 and aarch64, `CGO_ENABLED=0`, published to GitHub Releases with checksums, SBOM, and signed releases.

### 10.2 Local dev

`scripts/dev-up.sh` — orchestrates all three services + Postgres + Redis via Docker Compose, seeds the bootstrap registry, prints the dashboard URL.

### 10.3 Hosted SaaS

Hosted in **OCI `ca-toronto-1` (Toronto)**, co-located with Whimsy/Codero. `VERILINK_MULTI_TENANT=true`. Single region in v1. Postgres daily snapshots + WAL archiving; **quarterly restore drill**; RPO/RTO verified.

### 10.4 Docs site

Docusaurus, in `docs/`, versioned, MDX + OpenAPI/Redoc rendering.

---

## 11. Dashboard

TypeScript Vite SPA, reusing the Numera/Whimsy kit. Served by the control plane.

### 11.1 Provider view

- Trust-score summary: aggregated allow/deny counters over time (recharts), top agents by traffic, top denied fingerprints.
- Sampled decision feed (all denies + sampled allows).
- Agent list with canonical scores, `blacklisted` flag, `score_reason`.
- Policy editor: threshold slider, `below_threshold_action`, allow/deny fingerprint lists, `unsigned_max_score` cap, `fail_open_expired` toggle.
- API key management.
- Edge-node sync status (last sync version, heartbeat age, `stale` flag).
- Billing portal links (Stripe Customer Portal).

### 11.2 Agent-builder view

- Registered agents (by stable ID + key ids + assurance level).
- Attestation feed (incoming + outgoing), with `visibility` indicator.
- Trust score over time (recharts, from `network_score_history`).
- Issuer relationships.
- Billing portal links.

### 11.3 Admin (VeriLink staff) view

- Bootstrap registry editor with `current_weight`, `de_emphasis_reason`, `approved_by`.
- De-emphasis signal: sustained ≥10× organic-to-bootstrap attestation ratio over 30 days per seed; **staff clicks to initiate stepwise reduction** (not automatic).
- Tenant list with plan and usage.
- Graph health: total nodes, total edges, VeriRank lag, bootstrap-vs.-organic ratio.
- Issuer verification queue (proof-of-key-control challenges, manual review for higher `trust_weight`).

### 11.4 Graph visualization (v1)

Read-only summaries only: node/edge counts, top issuers by outgoing attestation volume. **Path-summary cards are removed** (they require hop/contribution data the v1 engine cuts). Interactive `@xyflow/react` explorer deferred to post-v1.

---

## 12. Clients

| Client | Status | v1 action |
|---|---|---|
| `client/go` | Existing | Add HTTP Message Signature signing helper; update default URL. |
| `client/node` | Existing | Publish to npm as `@verilink/node` with TS types + signing helper. |
| `client/rust` | Deferred | Post-v1. |

---

## 13. v1 scope and sequencing

1. **Go baseline benchmark** (`scripts/benchmark-baseline.sh`) — produce the `VR-002` artifact. If it fails, revisit the edge decision. **This is the first gate.**
2. **Monorepo restructure + CI** — directory layout, CI for Go + TS, parity harness scaffold (Go-only).
3. **Engine fixes** — `evaluation_time` determinism, `trust_weight`, `blacklisted` + `score_reason` + `entity_kind` output, `seed_score` removal, max-path documentation. New tests.
4. **Trust-engine gRPC** — client-streamed `RunVeriRank`, `VerifyAttestation` with candidate keys, `Fingerprint`. Contract tests.
5. **Control-plane TS foundation** — adapt Whimsy's `db/`, `middleware/`, `authz/`, `shared/`. Express + healthcheck. Migrations.
6. **Data model + domains** — schema in Section 5. `tenant`, `registry`, `graph`, `policy`, `bootstrap`, `billing`, `events`, `sync` domains.
7. **Request-auth protocol** — HTTP Message Signature verification in the Go edge; signing helpers in Go + Node clients.
8. **Attestation ingest end-to-end** — pre-parse JWS for `iss`/`iat`, resolve candidate keys, synchronous verify, schema validation, dedup on `token_digest`, lazy subject creation, enqueue VeriRank.
9. **Network score computation** — global VeriRank run (chunked), write to `network_scores` + `network_score_history` (on change), append to `sync_events`.
10. **Sync event log + edge sync** — snapshot + SSE stream with heartbeats; `410 Gone` on expired cursor.
11. **Go edge hardening** — HTTP Message Signatures, versioned sync client, atomic in-memory snapshot, bounded local WAL (drop-oldest + counter), atomic disk snapshots.
12. **Dashboard** — fork the kit; provider + agent-builder + admin views; read-only graph summaries; Stripe portal links.
13. **Bootstrap registry + cold-start seed** — curate initial root-of-truth; seed script; derive `is_bootstrap`.
14. **Deployment artifacts** — Dockerfiles, Helm, systemd unit, static binary releases.
15. **Clients** — publish Node to npm; update Go client with signing.
16. **Observability + security hardening** — Prometheus, Alertmanager (alert on `decisions_dropped_total`), OpenTelemetry, semgrep, secret scan.
17. **Whimsy integration migration** — point `shared/verilink.js` at hosted control plane; `behavioral@0` schema; lazy `vrl:` ID creation.
18. **Codero reference deployment** — guard `POST /memory/observations`; OpenCode/Codex session signs requests.
19. **Docs site** — Docusaurus; schema refs, quickstarts, integration guides, self-host guide.
20. **Backup/restore drill** — quarterly Postgres restore; RPO/RTO verified.
21. **Privacy review** — counsel validates retention/erasure model before processing personal data.

---

## 14. Out of scope for v1

- Rust edge verifier (deferred to post-v1 behind the parity harness).
- Rust client.
- Decentralized DID resolution beyond `did:key` verification methods.
- Per-tenant issuer weighting (issuer weights are global).
- `challenge` action.
- Interactive trust-graph explorer.
- Path-summary cards (require hop/contribution data).
- Embeddable reputation badge.
- Non-HTTP protocols at the edge.
- Mobile dashboard.
- SSO/SAML (OIDC only).
- mTLS for edge-to-control-plane.
- Metered/usage-based billing.
- Multi-region hosted deployment.
- PostgreSQL Row-Level Security (application-level in v1).
- `kid` in JWS signing (the Go `Sign()` doesn't set one today; v1 resolves candidate keys by `iat` from `issuer_keys`. Adding `kid` to signing is a clean post-v1 fix).
- Cross-language parity (Rust must match Go golden hashes to graduate post-v1; v1 is Go-only).
- Automatic bootstrap de-emphasis (manual, metric-gated in v1).
- Field-level facts visibility (attestation-level `visibility` only).

---

## 15. Open questions for round 3

1. **`behavioral@0` vs `@1` cutover.** Whimsy ships `@0` (no `schema_version`). Should the hosted control plane accept `@0` indefinitely or sunset it with a migration deadline? Proposed: accept `@0` for 6 months post-launch, then require `@1`.
2. **No-drop mode WAL capacity.** What is the default WAL size for enterprise tenants who opt into `no_drop_decisions`? Needs a sizing recommendation tied to expected decision rate and sync outage tolerance.
3. **HTTP Message Signature algorithm negotiation.** v1 mandates Ed25519 (`alg="ed25519"`). Should the protocol advertise supported algorithms via a well-known endpoint for future extensibility (e.g., P-256)? Proposed: yes, `GET /.well-known/verilink-params` returns `{ "signature_algorithms": ["ed25519"] }`.
4. **Snapshot compression format.** gzip vs zstd. Proposed: zstd (better ratio + speed; the Go edge has a mature zstd library).
5. **Privacy counsel review timing.** Step 21 in sequencing. Should it be earlier (before the privacy endpoints are built in step 12) to avoid rework?

---

## 16. Success criteria for v1

- [ ] A provider can sign up, get an API key, run the Go `edge-verifier` in front of a backend, and receive allow/deny decisions on signed agent traffic, end-to-end, in under 15 minutes from signup.
- [ ] **Go baseline benchmark** (`scripts/benchmark-baseline.sh`) passes: 10k req/s with sub-millisecond p99 local decision overhead (excluding upstream service time) on a pinned nightly-staging runner.
- [ ] An agent builder can register an agent's public-key identity, sign requests with HTTP Message Signatures, receive an attestation from a counterparty, and see a non-zero trust score in the dashboard.
- [ ] The bootstrap registry is seeded and providers see a non-empty graph on first sync.
- [ ] Whimsy's `shared/verilink.js` points at the hosted control plane; its `behavioral@0` attestations appear in the graph and dedup correctly on `token_digest`.
- [ ] Codero's `POST /memory/observations` is guarded by VeriLink; an OpenCode/Codex session signing requests is allowed; unsigned requests are capped or denied per policy.
- [ ] Self-hosted deployment via `docker-compose.self-host.yml` works with no manual SQL.
- [ ] The Node client is published to npm with signing support.
- [ ] `audit_log` records every state-changing administrative event; `decision_aggregates` + `decision_samples` record edge decisions via the bounded local WAL with at-least-once delivery and dedup on `(edge_node_id, wal_seq)`. **Dropped decisions are counted via `decisions_dropped_total` and alerted on — no silent loss.** Enterprise no-drop mode blocks when the WAL fills (opt-in).
- [ ] All three services have healthchecks wired to Kubernetes probes in the Helm chart.
- [ ] Postgres restore drill passes; RPO/RTO verified.
- [ ] `blacklisted` and `score_reason` are surfaced on the dashboard and in edge response headers, not inferred from `score == 0`.
- [ ] The unified sync event log propagates score, alias, key-revocation, and policy changes to connected edges via SSE within one minute.