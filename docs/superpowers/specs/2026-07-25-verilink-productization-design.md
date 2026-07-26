# VeriLink Productization Design

- **Status:** Draft v5 — review round 4 findings incorporated (approval round)
- **Date:** 2026-07-25 (v5: 2026-07-25)
- **Owner:** Sanjay
- **Repo:** `/srv/storage/repo/VeriLink/`
- **Related specs:** [`docs/specs/attestation_schema.md`](../../specs/attestation_schema.md), [`docs/specs/fingerprinting.md`](../../specs/fingerprinting.md), [`docs/specs/trust_graph.md`](../../specs/trust_graph.md)
- **Related roadmap:** [`ROADMAP.yml`](../../ROADMAP.yml) (MVP Phase 0 — all six tasks complete)

---

## Change log

- **v2–v4:** See prior change-log entries for the progression from v1 (global graph, corrected contracts, Go edge in v1, request-auth protocol, stable IDs, transactional sync, weighted roots, batch idempotency, three-way outcome, RFC 9421 corrections).
- **v5:** Resolves round-4 blocking findings: **signature covers `@target-uri` (path + query)** — restores request-path binding (path-swap replay closed); **invalid signature ≠ unsigned** — malformed/unknown/expired/replayed/unverifiable signatures return 401/403, only absent signatures passthrough; **identity resolved from `keyid`** — verified signature directly establishes the principal; fingerprints are for allow/deny lists + telemetry only (alias map, alias sync events removed from v1); **`principal_keys.control_verified_at`** added (assurance is no longer "derived" from an unstored fact); **`attestations.issuer_id` FKs `issuers(principal_id)`** + **composite FK to `principal_keys`**; **unique active `key_hash`** (one active key per principal); **`observation_id`** for split-visibility dedup (not `facts_hash`); **`facts_hash` = SHA-256(RFC 8785 JCS)**; **single bootstrap weight path** (`Root.weight` only; `issuers.trust_weight` stays 1.0 for bootstrap); **`decision_aggregates` valid SQL** (one PK, `dimension_kind` + non-null `dimension_value`, unique constraint); **`decision_batches` payload hash + CHECK**; **`network_scores` FK to `principals` (ON DELETE CASCADE, DEFERRABLE)**; **`trust_delta` CHECK -100..100**; **non-durable cursor SSE event** advances `Last-Event-ID` across tenant-filtered gaps; **no attestation sync event** (score recomputation emits the edge-visible event); **`behavioral@1` defined**; **`trust_graph.md` updated** to document max-path (not weighted-average); **retention spelled out for all nullable combinations**; **keychain claim softened**; `behavioral0_sunset_date` config (GA + 183 days); no-drop `required_outage_seconds` default 900s (independent of snapshot cap); Codero mandates `Idempotency-Key`; minors (4-row table retitled, stray `<` fixed, `score_reason` values defined).

---

## 1. Executive summary

VeriLink today is a working but internal Go toolkit for AI-agent identity and attestation: it fingerprints inbound requests, verifies signed JWS behavioral attestations, computes transitive trust scores via the VeriRank algorithm, and exposes an edge verifier reverse proxy that allows or denies traffic before it reaches an application. All six MVP roadmap tasks are complete and tests pass, but the system is in-memory only, ships no hosted surface, publishes no npm package, and the README itself states it is "not a hosted SaaS."

This document specifies how VeriLink becomes a proper product: an **open-source toolkit plus a hosted trust network** (the Tailscale/Snyk model), positioned as the trust protocol for the agentic economy. Any API provider can run the edge verifier in front of their API and make a deterministic trust decision about any autonomous agent in under one millisecond, without prior registration with that provider. Any agent builder can register their agent's cryptographic identity with VeriLink, receive attestations from counterparties who observe the agent's behavior, and carry a portable reputation across the network.

The two-sided network is cold-started by VeriLink itself: a curated root-of-truth registry, seeded at launch, de-emphasized (manually, metric-gated) as organic attestations take over.

The product is a single monorepo with four deployable surfaces: a Go edge verifier (v1) with a Rust edge rewrite deferred to post-v1 behind a parity harness, a TypeScript control plane and dashboard (reusing the hardened Numera/Whimsy stack — Express, Postgres, Redis, Radix, TanStack), a Go trust-engine gRPC service wrapping the existing verified algorithms, and the existing Go plus Node clients (npm-published). Whimsy is the first seeded issuer. Codero is the second reference customer, guarding a narrow agent-ingest endpoint.

The trust graph is **global**. Agents, issuers, attestations, and canonical network scores are shared across the network — and issuers and subjects share a single **`principals`** namespace, because VeriRank's transitive propagation requires an entity that receives trust (as a subject) to pass it on (as an issuer) under the same identifier. Tenants are a billing, ownership, API-key, and policy boundary — **not a score-visibility boundary** — though participant facts remain tenant-restricted.

---

## 2. Product positioning

### 2.1 What VeriLink is, post-productization

The trust protocol for the agentic economy. An open-source toolkit and a hosted trust network that together let any API provider make a deterministic trust decision about any autonomous agent in under one millisecond, without prior cooperation or registration with that provider.

### 2.2 The two-sided network

**Providers** run the Go edge verifier in front of their API. The verifier handles three request outcomes (4.3): signed+verified (resolve identity from the keyid, score, threshold policy), unsigned-passthrough (proxy with no trust verdict — the default for general APIs serving humans and ordinary clients), and unsigned-denied (per-policy, for pure agent endpoints). **Invalid signatures never passthrough** — they return 401/403 (4.3). Providers pay for the hosted control plane.

**Agent builders** register their agent's stable VeriLink identifier (`vrl:p:<uuid>`) with VeriLink, attach one or more public keys, and authenticate requests using HTTP Message Signatures (RFC 9421). Counterparties attest to the agent's behavior; the agent carries a portable reputation across the network. Free tier seeds the side; paid tier provides verified reputation, higher volume, and an SLA.

### 2.3 The cold-start wedge

VeriLink seeds a root-of-truth registry at launch: known agent frameworks (with published public keys), public API providers acting as issuers, and VeriLink's own bootstrap issuer. Providers see a non-empty graph on day one. Bootstrap weight is reduced stepwise (manually, metric-gated) as organic volume grows (6.1).

### 2.4 The moat

The trust graph data accrues only to the hosted network. The toolkit is auditable; the live network of attestations and computed scores is the asset competitors cannot copy. Network effects compound because the graph is global and principals are unified.

### 2.5 Tagline wedge

"Trust decisions for agents you've never met."

---

## 3. Decisions locked during brainstorming and review

| Decision | Choice | Rationale |
|---|---|---|
| Productization model | Open-source toolkit + hosted SaaS | Tailscale/Snyk model |
| Primary buyer | Two-sided network | Long-term moat |
| v1 scope | Full control plane + hardened OSS | Both sides onboarding from day one |
| Trust graph partitioning | Global graph; tenant-scoped policy/ownership only | Canonical scores network-wide; tenants apply thresholds as a policy overlay. **Not a score-visibility boundary**; participant facts are tenant-restricted. |
| Principal identity model | **Unified `principals` table; one namespace `vrl:p:<uuid>`** | VeriRank keys scores by a single string; subject and issuer must share a namespace for transitive propagation. Matches `pkg/trust/engine.go`. |
| Request authentication | HTTP Message Signatures (RFC 9421) + Content-Digest (RFC 9530) | Every signed request proves possession. `key_hash` = SHA-256 over the raw 32-byte Ed25519 public key, derived after verification. |
| **Signature covered components** | **`@method`, `@target-uri`, `content-digest`, and `Idempotency-Key` when present** | `@target-uri` binds the request path + query (path-swap replay closed). `@authority` is subsumed by `@target-uri`. `Idempotency-Key` covered when the endpoint requires it. |
| **Invalid vs. absent signature** | **Absent → `unsigned_action` (passthrough/deny). Present but malformed/unknown/expired/replayed/unverifiable → 401/403.** | Invalid auth is never treated as unauthenticated passthrough. |
| **Identity resolution** | **From verified `keyid` directly** — the principal is established once the signature verifies. Fingerprints are for allow/deny lists + telemetry only. | Aliases were incoherent for unsigned requests (no key hash); signed requests don't need them. Alias map + alias sync events removed from v1. |
| Request outcomes | Three-way: signed+verified / unsigned-passthrough / unsigned-denied | General APIs serve humans; passthrough is default. Pure agent endpoints deny unsigned. No `unsigned_max_score` cap. |
| Edge stack (v1) | Go (the existing edge-verifier), gated on a fresh baseline benchmark | First implementation step produces the `VR-002` artifact. |
| Edge stack (post-v1) | Rust behind FFI parity harness | After byte-identical fingerprints proven. |
| Control-plane stack | TypeScript (reusing Numera/Whimsy) | Maximal reuse. |
| Trust-core algorithms | Stay Go, exposed via gRPC | Avoids a third reimplementation. |
| `kid` in JWS | In v1 (required for native submissions; allowlisted legacy exception for Whimsy) | Explicit key selection; candidate-key-by-iat trial is the legacy fallback. |
| `facts_private` | Removed | Conflicts with attestation-level `visibility`. One attestation = one visibility. |
| Split-visibility doubling | **`vli.observation_id`** — paired attestations share it; scoring counts one edge per `(issuer_id, subject_id, observation_id)` | `facts_hash` can't match across public/private variants (different facts by construction). |
| `facts_hash` | **SHA-256(RFC 8785 JCS)** | Exact-content identity; JCS specifies number/string/Unicode normalization. |
| `trust_delta` constraints | **`CHECK (trust_delta BETWEEN -100 AND 100)` + sign constraint** (negative only for `negative_incident`) | Range + sign. |
| Bootstrap weight path | **`Root.weight` only** (initializes root at `100 × weight`). Bootstrap issuers keep `trust_weight = 1.0`; `trust_weight` is the orthogonal issuer-quality knob. | Single mechanism; avoids quadratic reduction. |
| Bootstrap de-emphasis | Manual, metric-gated; stepwise `Root.weight` reduction with rollback | Trigger: ≥3 independent verified organic issuers, ≥80% organic weighted contribution for 30 days, counterfactual removal report. |
| `network_scores` FK | **In v1** — FK to `principals` (`ON DELETE CASCADE`, `DEFERRABLE INITIALLY DEFERRED`) | Every scored principal is created before scoring; a dangling score is a bug, not an optimization. |
| Repo structure | Single monorepo | Small team. |
| OIDC provider | Clerk via OAuth Application + Authorization Code/PKCE + Account Portal, against generic OIDC (`openid-client`) | Not the Clerk session SDK. |
| Billing | Stripe Billing, fixed-tier subscriptions | Defer metered. |
| Docs generator | Docusaurus | React/TS alignment. |
| Hosted region | OCI `ca-toronto-1` (Toronto) | Co-located with Whimsy/Codero. |
| Static edge binary | Yes | Linux x86_64 + aarch64, `CGO_ENABLED=0`, systemd unit, checksums, SBOM, signed releases. |
| Graph visualization (v1) | Read-only summaries only | No path-summary cards (require cut data). No interactive explorer. |
| Reputation badge | Post-v1 | Marketing surface. |
| Challenge action | Cut from v1 | allow/deny/passthrough only. |
| Behavioral@0 | Sunset: `BEHAVIORAL_V0_CUTOFF` config = GA + 183 days, allowlisted legacy issuers only (initially Whimsy), startup fails if GA mode without it, 422 after cutoff | Mechanism, not an invented date. |
| No-drop WAL | `wal_max_bytes = max(8 GiB, calculated)`, formula `ceil(p99_wal_bytes/s × required_outage_seconds × 1.5)`, default `required_outage_seconds = 900` (independent of snapshot cap) | |
| Capability discovery | `GET /.well-known/verilink` | `params_version`, algorithms, required components, nonce requirement, max age, skew. v1 accepts only ed25519. |
| Snapshot compression | gzip mandatory, zstd optional via Accept-Encoding | gzip stable + dependency-free in Node 24. |
| Privacy counsel | Two stages: pre-schema (before step 6) + pre-ingest (before step 17) | Erasure depends on legal basis. |
| Codero `Idempotency-Key` | **Mandated** at `POST /memory/observations`; covered in the signature; backend enforces uniqueness; same key + same body = original result, same key + different digest = 409 | Reference deployment models the recommended-practice ceiling. |

---

## 4. Architecture

### 4.1 Monorepo layout

```text
verilink/
├── pkg/                    # Go — trust core (existing, hardened)
│   ├── fingerprint/  attestation/  trust/  verifier/
├── cmd/
│   ├── trust-engine/       # gRPC server exposing pkg/*
│   ├── edge-verifier/      # v1 edge (HTTP Message Signatures, sync, WAL)
│   ├── attestation-service/# deprecated after TS control plane ships
│   └── keygen/
├── edge-rs/                # DEFERRED to post-v1 (parity harness only)
├── control-plane/          # TS — adapts Whimsy api/ patterns
│   └── src/domains/{tenant,registry,graph,sync,bootstrap,policy,billing,events}
├── dashboard/              # TS — Vite + Radix + TanStack
├── client/{go,node,rust}   # rust deferred; go+node add signing
├── deploy/{docker,helm,systemd}
├── docs/                   # Docusaurus + specs/ (facts JSON Schemas)
└── scripts/{dev-up.sh,benchmark-baseline.sh,parity-check.sh}
```

### 4.2 Deployable components

| Component | Language | Port | Role |
|---|---|---|---|
| `edge-verifier` (v1) | Go | 8080 (data), 9090 (admin) | Reverse proxy. Three-way outcome. Verifies HTTP Message Signature, resolves principal from `keyid`, looks up local trust cache, allow/deny/passthrough. Pulls sync event stream. |
| `control-plane` | TypeScript (Express) | internal HTTP behind ingress; gRPC to trust-engine | Multi-tenant API: principal/issuer registry, attestation submit/verify, sync event log + snapshot, policy, API keys, onboarding, billing. |
| `trust-engine` | Go (gRPC) | 9091 | Stateless VeriRank + attestation verify + fingerprint. |
| `dashboard` | TypeScript (Vite SPA) | served by control-plane | Provider + agent-builder + admin views. |

Postgres (durable source of truth), Redis (sync buffer, rebuilt from Postgres; rate limits). Edge is local-memory only.

Edge deployment topology is configurable (`edge.kind`: DaemonSet | Deployment | static binary + systemd unit).

### 4.3 Request authentication and outcomes

**Three-way outcome model:**

| Outcome | Trigger | Behavior |
|---|---|---|
| **Signed + verified** | Valid HTTP Message Signature for a registered, non-revoked key | Resolve the principal **directly from `keyid`** (`<vrl:p:<uuid>#<key-id>` → principal). Look up score. Apply threshold policy → `allow`/`deny`. `X-Verilink-Status: Allowed\|Denied`. |
| **Unsigned passthrough** | **Neither** `Signature` **nor** `Signature-Input` header present, policy `unsigned_action = passthrough` (default) | Proxy to backend with `X-Verilink-Status: Unverified`. No trust verdict. Default for general APIs. |
| **Unsigned denied** | **Neither** `Signature` **nor** `Signature-Input` header present, policy `unsigned_action = deny` | 403, `X-Verilink-Status: Denied`, `X-Verilink-Reason: unsigned`. For pure agent endpoints (Codero). |
| **Invalid signature (any failure)** | `Signature` or `Signature-Input` present (incomplete pair, malformed, unknown `keyid`, expired `created`, replayed nonce, or unverifiable) | **401** (authn failure) or **403** (known key, no permission). `X-Verilink-Status: Denied`, `X-Verilink-Reason: invalid-signature\|unknown-key\|expired\|replayed`. **Never passthrough.** A present-but-incomplete header pair is an authentication attempt, not an unsigned request. |

**HTTP Message Signature profile (RFC 9421 + RFC 9530):**

For body-bearing, idempotent requests:
```http
Signature-Input: sig1=("@method" "@target-uri" "content-digest" "idempotency-key");created=<unix>;keyid="vrl:p:<uuid>#<key-id>";alg="ed25519";nonce="<128-bit-hex>"
Signature: sig1=:<base64-signature>:
```

For bodyless or non-idempotent requests, `content-digest` and/or `idempotency-key` are omitted from the covered components as appropriate:
```http
Signature-Input: sig1=("@method" "@target-uri");created=<unix>;keyid="vrl:p:<uuid>#<key-id>";alg="ed25519";nonce="<128-bit-hex>"
Signature: sig1=:<base64-signature>:
```

- **Covered components:** `@method`, `@target-uri` (binds scheme + authority + path + query — path-swap replay closed), `content-digest` (for requests with bodies), and `idempotency-key` (when the endpoint requires it; covered by the signature so a captured signed request cannot be replayed with a different key). `@authority` is subsumed by `@target-uri` and is omitted.
- **`created`** is a signature parameter, not a covered component. Accepted window: up to 30 seconds in the future (skew) and no more than 5 minutes in the past.
- **`nonce`** is a 128-bit hex random value, unique per `(keyid, nonce)` within the acceptance window + skew. The edge maintains a replay cache for at least window + skew (5 min + 30 s).
- **`keyid`** is `vrl:p:<uuid>#<key-id>` (no stray `<` — this is the literal format).
- **`key_hash` derivation:** SHA-256 over the **raw 32-byte Ed25519 public key** (not JWK JSON). Computed by the edge after successful verification; caller-supplied key hashes are ignored.
- **Behind a TLS-terminating LB:** the edge reconstructs the externally-visible `@target-uri` using the `external_base_url` edge config (e.g. `https://api.example.com`). Without it, verification fails on misconfigured deployments.
- **Cross-edge replay:** within the 5-minute `created` window, a captured signed request replays against a *different* edge node (nonce cache is edge-local). v1 accepts this for endpoints that don't require `Idempotency-Key`. Endpoints that require `Idempotency-Key` (e.g. Codero's) are protected because the key is covered by the signature and enforced by the backend.

**Capability discovery:** `GET /.well-known/verilink` returns:
```json
{
  "params_version": 1,
  "signature_algorithms": ["ed25519"],
  "digest_algorithms": ["sha-256"],
  "required_components": ["@method", "@target-uri"],
  "nonce_required": true,
  "max_age_seconds": 300,
  "max_skew_seconds": 30
}
```

**Client signing support:** the Go and Node clients gain a signing helper. The agent's private key is supplied by the caller and never sent to VeriLink.

### 4.4 Identity model

**Unified principals.** All trust-graph entities — agents and issuers — live in a single `principals` table with one namespace: `vrl:p:<uuid>`. This is load-bearing: VeriRank (`pkg/trust/engine.go`) keys scores by a single string, and an entity that receives trust as a subject must pass it on as an issuer under the same ID for transitive propagation to work.

`attestations.issuer_id` references `issuers(principal_id)` (a subject-only principal cannot issue), and `attestations.subject_id` references `principals(id)` (any principal can be a subject, including an issuer for `kyb`). A principal can be both an issuer and a subject.

**Principal attributes:**

- `id` — `vrl:p:<uuid>`, the canonical network identifier.
- `entity_kind` — `agent | issuer | both`.
- `owner_tenant_id` — the tenant that owns this principal (for dashboard access, private-facts authorization). Nullable for bootstrap seeds.
- `assurance_level` — **derived from `principal_keys`**: `verified_key` if the principal has at least one non-revoked key with `control_verified_at` set, else `unknown`. Stored as a view or computed on read. `control_verified_at` is the stored fact that makes "proven control" checkable.

**Keys:** one or more public keys per principal, in `principal_keys`, each expressed as a `did:key` verification method and identified by a `key_id` (e.g. `k1`). Supports rotation and history. The JWS `kid` header carries the `key_id` (required for native v1 submissions). **A public key (`key_hash`) is globally unique** — one key belongs to at most one principal, even across rotation/validity windows (enforced by a global unique index on `key_hash`). This prevents key reuse across principals.

**Lazy subject creation:** a subject can be attested to before it registers a key. The control plane creates the principal with `vrl:p:<uuid>`, no key, `assurance_level = unknown`. A later verified registration attaches a key (sets `control_verified_at`) and upgrades assurance to `verified_key`.

**Fingerprints** (JA4 + canonicalized headers + key hash) are **diagnostic only** in v1: they appear in allow/deny fingerprint lists, decision telemetry, and `X-Verilink-Fingerprint-Mode` headers. They do **not** drive identity resolution (the verified `keyid` does that). The alias map, `agent_fingerprints` table, and `alias.*` sync events are **removed from v1** — they added complexity for a correlation path that unsigned requests can't use (no key hash) and signed requests don't need (`keyid` resolves directly). They may return post-v1 if header-only correlation becomes valuable.

### 4.5 Data flow

**Attestation ingest:**

1. A counterparty signs a JWS attestation (`iss` = `vrl:p:<issuer-uuid>`, `sub` = `vrl:p:<subject-uuid>`, `kid` = key id, `vli.schema_version`, `vli.type`, `vli.facts`, `vli.visibility`, `vli.trust_level_delta`, optional `vli.observation_id`). `trust_delta` is in `[-100, 100]`; negative only for `negative_incident`, nonnegative for other types.
2. `control-plane POST /v1/attestations/submit` with the signed JWS.
3. The control plane **pre-parses the unverified JWS** for `iss`, `kid`, and `iat`. It resolves the candidate key from `principal_keys` valid at `iat` and not revoked. If `kid` is present, it selects that key directly; otherwise it falls back to trying each candidate key (legacy). Unknown `iss`: reject 4xx and audit.
4. **Synchronous** signature verification via `trust-engine.VerifyAttestation` (caller supplies `{key_id, public_key}` candidates; engine returns the `verified_key_id` it used). **Synchronous** schema validation against the versioned facts schema for `vli.type@vli.schema_version`. **Synchronous** dedup on `token_digest` (sha256 of JWS, NOT NULL UNIQUE). Invalid → deterministic 4xx.
5. On success: the subject principal is lazily created if absent. The attestation is stored transactionally. **No attestation sync event is written** — attestations are not edge-visible; only score recomputation emits edge-visible events. A `RunVeriRank` job is enqueued (debounced, one run per minute, plus **hourly periodic recompute** so time decay advances).

**Score computation:**

1. The control plane loads the **active, non-superseded** global attestation set, filtered to attestations younger than **ten half-lives (1800 days)** — at which point the contribution is <0.1% and the truncation error is explicitly tested. **Grouping key:** `observation_id` when non-empty (explicitly paired attestations deduplicate to one edge per `(issuer_id, subject_id, observation_id)` — split-visibility dedup, 5.5); otherwise `attestation.id` (unpaired attestations never collapse — each is its own group).
2. It calls `trust-engine.RunVeriRank` (client-streamed, chunked) with the attestation set, the global principal list (with `trust_weight` and `is_bootstrap`), the **weighted bootstrap roots** (`Root { id, weight }`), and an explicit `evaluation_time`. The principal list is streamed as `Principal { id, entity_kind, trust_weight }` rows (entity_kind comes from here, not inferred post-hoc).
3. The engine runs VeriRank (max 4 hops, distance decay `0.8^d`, time decay half-life 180 days). Roots initialize at `100 × weight` (weighted bootstrap; default `weight = 1.0` → 100). Output is keyed by `vrl:p:<uuid>`, with `entity_kind`.
4. The control plane writes results to `network_scores` (durable, FK to `principals` ON DELETE CASCADE DEFERRABLE) and `network_score_history` (only on score change). It appends `score.upsert` / `score.delete` events to `sync_events` **in the same transaction** (4.7).

**Edge sync (unified `sync_version`, transactionally safe):**

1. `edge-verifier` boots with a tenant API key over TLS.
2. It fetches a **full snapshot**: `GET /v1/sync/snapshot` returns a versioned, compressed (gzip, or zstd via Accept-Encoding) payload containing the global score table, the **active principal verification keys** (principal ID + key ID + public key + `valid_from` + `valid_until`), and this tenant's active policy. The edge replaces its in-memory snapshot **atomically**. The edge **enforces key validity windows locally** (`valid_from`/`valid_until`) — a key outside its window is rejected as `unknown-key` even if the control plane hasn't yet emitted `key.revoke`. The snapshot includes a `high_water_version` from a **repeatable-read** image.
3. Subsequent updates arrive as **SSE events** from a unified `sync_events` log keyed by a monotonic `sync_version`. Event types: `score.upsert`, `score.delete`, `key.upsert` (carries `valid_from`/`valid_until`), `key.revoke`, `policy.replace`. The edge applies events in order. If its `Last-Event-ID` is pruned: `410 Gone` → fetch a new full snapshot.
4. **Heartbeats are SSE keepalive comments** (`: ping\n\n`), not durable `sync_events` rows. Freshness is "bytes received on an authenticated stream."
5. **Non-durable cursor events:** the SSE stream is **filtered per tenant** (`policy.replace` only to the owning tenant). To advance `Last-Event-ID` past events belonging to other tenants (so an edge doesn't get `410` for a version it skipped), the control plane periodically sends a **non-durable cursor SSE event** whose `id` is the committed `high_water_version` — it advances the cursor without allocating a new `sync_version`.
6. The SSE stream is filtered per tenant: global score/key events to all edges; `policy.replace` only to the owning tenant's edges.
7. The edge persists each snapshot to disk atomically (`snapshot.json.tmp` → `rename`).
8. Postgres is the durable truth; Redis is rebuilt from Postgres after a restart.

**Allow/deny/passthrough decision:**

1. Inbound request hits `edge-verifier` on 8080.
2. The edge checks for `Signature` and `Signature-Input` headers.
   - **Neither present:** apply `policy.unsigned_action` → `passthrough` (proxy, `X-Verilink-Status: Unverified`) or `deny` (403, `X-Verilink-Reason: unsigned`).
   - **Either present (incomplete pair) or both present + valid:** treat as an authentication attempt. Verify per 4.3. Resolve the principal **directly from `keyid`** (no alias map). Derive `key_hash` from the verified raw 32-byte public key. Look up the network score (`blacklisted`, `score_reason` are explicit fields). Apply threshold policy → `allow`/`deny`. The fingerprint is computed for telemetry + allow/deny list matching only.
   - **Either present but incomplete/malformed/unknown/expired/replayed/unverifiable:** 401/403, `X-Verilink-Status: Denied`, `X-Verilink-Reason: invalid-signature|unknown-key|expired|replayed`. Never passthrough.
3. The decision is written to a bounded local WAL with a per-edge monotonic `wal_seq`, flushed in batches with a `batch_id`. WAL-full → drop oldest + increment `decisions_dropped_total` (default); or block (enterprise `no_drop_decisions`, opt-in).
4. **An edge offline >24h:** SSE returns `410 Gone` → full snapshot → resume.

### 4.6 Trust-engine gRPC contract

Corrected: `Principal` stream rows (entity_kind from here), `Root { id, weight }`, `verified_key_id` return, raw JSON facts, client-streamed input.

```proto
service TrustEngine {
  rpc RunVeriRank(stream RunChunk) returns (ScoreTable);
  rpc VerifyAttestation(VerifyRequest) returns (VerifyResult);
  rpc GetFingerprint(FingerprintRequest) returns (Fingerprint);
}

message RunChunk {
  oneof payload {
    RunHeader header = 1;
    Attestation attestation = 2;
    Principal principal = 3;   // streams entity_kind + trust_weight
    Root root = 4;
  }
}
message RunHeader {
  int64 evaluation_time_unix = 1;
}
message Attestation {
  string issuer_id = 1;            // vrl:p:<uuid>
  string subject_id = 2;           // vrl:p:<uuid>
  int32 trust_delta = 3;
  int64 issued_at_unix = 4;
  int64 expires_at_unix = 5;
  string attestation_type = 6;
  string observation_id = 7;       // for split-visibility grouping; empty = no pairing
}
message Principal {
  string id = 1;                   // vrl:p:<uuid>
  string entity_kind = 2;          // agent | issuer | both
  double trust_weight = 3;
  bool is_bootstrap = 4;
}
message Root {
  string id = 1;                   // vrl:p:<uuid> — a bootstrap principal (always an issuer)
  double weight = 2;                // 0.0..1.0; root initializes at 100 × weight
}

message ScoreTable {
  repeated ScoreRow rows = 1;
  int64 computed_at_unix = 2;
}
message ScoreRow {
  string principal_id = 1;
  string entity_kind = 2;          // from the streamed Principal rows
  int32 score = 3;
  bool blacklisted = 4;
  string score_reason = 5;         // propagated | blacklisted (expired is handled by the control plane as score.delete, not an engine row)
}

message VerifyRequest {
  string jws_token = 1;
  repeated KeyCandidate candidate_keys = 2;
}
message KeyCandidate {
  string key_id = 1;               // e.g. k1
  bytes public_key = 2;            // raw 32-byte Ed25519 public key
}
message VerifyResult {
  bool valid = 1;
  string verified_key_id = 2;      // which candidate matched
  string issuer_id = 3;
  string subject_id = 4;
  AttestationPayload payload = 5;
  string error = 6;
}
message AttestationPayload {
  string attestation_type = 1;
  bytes facts_json = 2;            // raw verified JSON bytes
  int32 trust_level_delta = 3;
  int64 issued_at_unix = 4;
  int64 expires_at_unix = 5;
  string jti = 6;
  string schema_version = 7;
  string visibility = 8;           // participants | public
  string observation_id = 9;
}

message FingerprintRequest {
  string ja4 = 1;
  map<string, string> headers = 2;
  string key_hash = 3;             // SHA-256 over raw 32-byte public key
  string protocol = 4;
}
message Fingerprint { string sha256 = 1; }
```

**Engine work required for v1:**

1. **Determinism fix:** replace `time.Now()` with supplied `evaluation_time`.
2. **`trust_weight` application:** per-issuer multiplier on contributions. **Bootstrap issuers keep `trust_weight = 1.0`** — de-emphasis is via `Root.weight`, not `trust_weight`. `trust_weight` is the orthogonal issuer-quality knob.
3. **`blacklisted` + `score_reason` output:** expose the existing blacklist override. `score_reason` enum values:
   - `propagated` — the score was computed via VeriRank propagation from a root.
   - `blacklisted` — a `negative_incident` from an issuer with score ≥ 80 zeroed this principal.
   - `expired` is **removed from the engine enum** — score computation loads only active attestations and time decay never literally reaches zero; when a principal disappears from the VeriRank result (all attestations expired/superseded), the **control plane** (not the engine) deletes its `network_scores` row and emits `score.delete`.
   - `unknown` is **not** a stored `score_reason` — unknown principals have no `network_scores` row (per 7.1). `verified` is removed (it was redundant with `propagated` — the engine is pure propagation from roots; a root's own score is `propagated` from itself).
4. **Weighted roots:** `Root { id, weight }`; initialize at `100 × weight`. Default `weight = 1.0`. Stepwise de-emphasis reduces `weight`. **Single path:** `Root.weight` is the only de-emphasis mechanism; `issuers.trust_weight` is not touched by de-emphasis.
5. **Max-path algorithm locked:** the engine takes the max trust path (`engine.go:160`), not weighted average. `trust_graph.md` is updated to match (v5). Consensus redesign deferred.
6. **`observation_id` grouping:** the control plane groups attestations by `observation_id` when non-empty (one representative attestation per `(issuer_id, subject_id, observation_id)` group — most restrictive visibility) and by `attestation.id` otherwise (unpaired attestations are never collapsed). The proto carries `observation_id` for traceability.

### 4.7 Sync event log (transactionally safe)

A single durable, monotonic event log drives edge sync. `sync_version` is **transactionally safe**: state mutation and the `sync_events` row are written in the **same Postgres transaction**, and `sync_version` is allocated by a **locked allocator** (or a transactional outbox with a single dispatcher) so commit order equals version order. A full snapshot reads from a **repeatable-read** transaction and includes the `high_water_version` from that image.

```sql
sync_events (
  sync_version    bigint pk,          -- allocated by the locked allocator, in-commit-order
  event_type      text not null,      -- score.upsert | score.delete | key.upsert | key.revoke | policy.replace
  principal_id    text,                -- for score/key events
  tenant_id       uuid,                -- for policy.replace
  payload         jsonb not null,
  created_at      timestamptz not null default now()
);
-- No alias.* events (aliases removed from v1). No attestation events (not edge-visible).
-- No heartbeat rows (heartbeats are SSE : ping comments).
```

**Non-durable cursor events** (4.5 step 5) are SSE-only; they are not `sync_events` rows.

### 4.8 Reused vs. adapted (delta from Whimsy)

| Whimsy module | Adaptation |
|---|---|
| `api/src/db/*` | New schema; same Pool/migrate patterns |
| `api/src/middleware/auth.js` | **Substantial:** drop Firebase, add Clerk OAuth + PKCE, `vrl_` key format, membership resolution, tenant-billing gating. HMAC-SHA256 ports cleanly. |
| `api/src/middleware/{rateLimit,audit}.js` | Per-tenant quotas; new audit actions |
| `api/src/authz/` | VeriLink resources; global-vs-tenant distinction |
| `api/src/shared/*` | New key patterns; new audit actions |
| `app/` kit | Fork as scaffold; VeriLink views |
| `api/src/domains/billing/*` | Reuse checkout/portal/webhook; persist webhook IDs |

### 4.9 Reference customers

**Whimsy** is the first seeded issuer. Its `shared/verilink.js` submits `behavioral` attestations. Compatibility fixes (6.3): `behavioral@0` schema (allowlisted legacy, `BEHAVIORAL_V0_CUTOFF` = GA + 183 days), `token_digest` dedup, lazy `vrl:p:` ID creation, default `visibility: participants` and `schema_version: "0"` for missing fields. Whimsy migrates to `behavioral@1` at launch (6.4). Whimsy's `remoteFingerprint` proves the issuer loop, not provider-side agent identification.

**Codero** is the second reference customer, proving the provider loop. A VeriLink-guarded listener in front of `POST /memory/observations`. An OpenCode/Codex session signs requests via HTTP Message Signatures, including a covered `Idempotency-Key` (mandated). Backend enforces uniqueness: same key + same `Content-Digest` = original result; same key + different digest = 409. The session's private key is stored in the **OS keychain** (macOS Keychain, Linux Secret Service, Windows Credential Manager) rather than a file or env var, and is loaded only at signing time. The signer component can access the key; the model/tool layer, logs, environment, and VeriLink cannot. VeriLink is not placed in front of the entire Codero dashboard API — only the agent-write surface.

---

## 5. Data model

Postgres. **Logical schema** — executable DDL is generated by the Whimsy-style migration runner. The graph is **global**. Isolation is **application-level** in v1. Tenant-scoped cross-references use **composite tenant-safe FKs**.

### 5.1 Global graph tables

```sql
-- Unified principals: agents and issuers share one namespace.
principals (
  id              text pk,                  -- vrl:p:<uuid>
  entity_kind      text not null,            -- agent | issuer | both
  name            text,
  owner_tenant_id uuid references tenants(id),
  metadata        jsonb default '{}',
  first_seen_at   timestamptz not null default now(),
  last_seen_at    timestamptz not null default now(),
  status          text not null default 'active',  -- active | deactivated
  deactivated_at  timestamptz
);
-- assurance_level is DERIVED from principal_keys (has a non-revoked key with
-- control_verified_at set → verified_key; else unknown). Not a stored column.

-- Principal keys (rotation/history)
principal_keys (
  principal_id    text not null references principals(id),
  key_id          text not null,            -- e.g. k1
  public_key_raw  bytea not null,           -- raw 32-byte Ed25519 public key
  public_key_jwk  jsonb not null,           -- did:key verification method form
  key_hash        text not null,            -- sha256(public_key_raw); indexed for lookup
  control_verified_at timestamptz,         -- set when the principal proved control of this key
  valid_from      timestamptz not null default now(),
  valid_until     timestamptz,              -- null = current
  revoked_at      timestamptz,
  revocation_reason text,
  primary key (principal_id, key_id)
);
-- A public key is globally unique by key_hash: one key belongs to at most
-- one principal, even across rotation/validity windows. Enforced by:
--   unique index key_hash_unique on (key_hash)
-- This prevents a finite-lived but currently active key from being attached
-- to multiple principals (the partial-index form only covered valid_until IS NULL).

-- Issuer attributes (a principal that can sign attestations)
issuers (
  principal_id    text pk references principals(id),
  trust_weight    numeric(3,2) default 1.0, -- issuer-quality knob; NOT touched by bootstrap de-emphasis
  is_bootstrap    boolean default false,    -- derived from bootstrap_issuers by seeder
  verified_at     timestamptz,             -- set after proof of key control + review
  created_at      timestamptz not null default now()
);

-- Attestations: signed behavioral reports (global)
attestations (
  id              uuid pk,
  issuer_id       text not null references issuers(principal_id),  -- subject-only principals cannot issue
  subject_id      text not null references principals(id),          -- any principal (agent or issuer)
  jws_token       text not null,
  token_digest    text not null unique,    -- sha256(jws_token); dedup
  payload         jsonb not null,
  facts           jsonb not null,          -- shareable facts (public or participants)
  facts_hash      text not null,            -- sha256(RFC 8785 JCS(facts)); exact-content identity
  visibility      text not null default 'participants',  -- participants | public
  trust_delta     integer not null,        -- [-100, 100]
  attestation_type text not null,
  schema_version  text not null,           -- mandatory for native v1; "0" allowlisted legacy
  jti             text,                    -- advisory
  observation_id  text,                    -- for split-visibility pairing; null = no pairing
  issued_at       timestamptz not null,
  expires_at      timestamptz,
  superseded_by   uuid references attestations(id),
  sig_verified    boolean not null default true,
  verified_key_id text not null,                    -- which key verified (from VerifyResult); NOT NULL so the composite FK cannot be bypassed
  received_at     timestamptz not null default now(),
  CHECK (trust_delta BETWEEN -100 AND 100),
  CHECK (
    (attestation_type = 'negative_incident' AND trust_delta < 0)
    OR (attestation_type <> 'negative_incident' AND trust_delta >= 0)
  ),
  -- Composite FK: the verified key belongs to the issuer
  FOREIGN KEY (issuer_id, verified_key_id) REFERENCES principal_keys(principal_id, key_id)
);

-- Network scores: materialized VeriRank output (global)
-- FK to principals (ON DELETE CASCADE — scores are derived data).
-- DEFERRABLE INITIALLY DEFERRED so the score writer can insert the principal
-- and the score in the same transaction without ordering constraints.
network_scores (
  principal_id    text not null references principals(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  entity_kind     text not null,
  score           integer not null,
  blacklisted     boolean not null default false,
  score_reason    text not null,           -- propagated | blacklisted (expired → control plane deletes the row + emits score.delete)
  computed_at     timestamptz not null default now(),
  sync_version    bigint not null,
  primary key (principal_id)
);

-- Score history: one row per principal per score CHANGE
network_score_history (
  principal_id    text not null references principals(id) ON DELETE CASCADE,
  score           integer not null,
  blacklisted     boolean not null,
  score_reason    text not null,
  computed_at     timestamptz not null,
  sync_version    bigint not null,
  primary key (principal_id, sync_version)

-- Sync event log (unified, transactionally safe) — see 4.7
sync_events (
  sync_version    bigint pk,
  event_type      text not null,           -- score.upsert | score.delete | key.upsert | key.revoke | policy.replace
  principal_id    text,
  tenant_id       uuid,
  payload         jsonb not null,
  created_at      timestamptz not null default now()
);

-- Bootstrap registry (issuers only — roots are always issuers)
bootstrap_issuers (
  principal_id    text pk references issuers(principal_id),
  name            text not null,
  current_weight  numeric(3,2) not null default 1.0,  -- written through to Root.weight (NOT issuers.trust_weight)
  seeded_at       timestamptz not null default now(),
  de_emphasized_at timestamptz,
  de_emphasis_reason text,
  approved_by     uuid references users(id)
);
-- No bootstrap_agents table. Seeded agents are cold-started via bootstrap-issuer
-- attestations; they are not roots. De-emphasizing a seeded agent = superseding
-- its bootstrap attestations.
-- is_bootstrap on issuers is derived by the seeder from this table.
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

-- Global users
users (
  id           uuid pk,
  email        citext unique not null,
  oidc_issuer  text not null,
  oidc_subject text not null,
  created_at   timestamptz not null default now(),
  unique (oidc_issuer, oidc_subject)
);

tenant_memberships (
  user_id      uuid not null references users(id),
  tenant_id    uuid not null references tenants(id),
  role         text not null default 'member',
  created_at   timestamptz not null default now(),
  primary key (user_id, tenant_id)
);

-- API keys — HMAC-SHA256. Format: vrl_ + exactly 64 lowercase hex.
api_keys (
  id              uuid pk,
  tenant_id       uuid not null references tenants(id),
  key_prefix      text not null,
  key_hash_hmac   text not null,
  scopes          text[] not null,
  last_used_at    timestamptz,
  created_at      timestamptz not null default now(),
  revoked_at      timestamptz,
  unique (tenant_id, id)
);

-- Policies: per-tenant threshold + actions (overlay on global scores)
policies (
  id                       uuid pk,
  tenant_id                uuid not null references tenants(id),
  name                     text not null,
  threshold                integer not null default 50,
  below_threshold_action   text not null default 'deny',  -- allow | deny
  unsigned_action          text not null default 'passthrough',  -- passthrough | deny
  allow_fingerprints       text[] default '{}',   -- exact-match allow (precedence over threshold)
  deny_fingerprints        text[] default '{}',   -- exact-match deny (precedence over threshold + score)
  fail_open_expired        boolean not null default false,
  no_drop_decisions        boolean not null default false,
  max_snapshot_age_seconds integer not null default 300,   -- 60..1800
  allow_sample_rate        numeric(4,3) not null default 0.010,  -- 0.000..1.000
  is_active                boolean not null default true,
  created_at               timestamptz not null default now(),
  unique (tenant_id, name)
  -- partial unique index active_policy_per_tenant on (tenant_id) where is_active
);

-- Edge nodes
edge_nodes (
  id              uuid pk,
  tenant_id       uuid not null references tenants(id),
  name            text not null,
  api_key_id      uuid,
  last_seen_at    timestamptz,
  last_sync_version bigint,
  status          text not null default 'unknown',
  created_at      timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, api_key_id) references api_keys(tenant_id, id)
);

-- Sync cursors
sync_cursors (
  tenant_id       uuid not null,
  edge_node_id    uuid not null,
  last_cursor     bigint not null default 0,
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

-- Stripe webhook event dedup (global)
stripe_webhook_events (
  id              text pk,
  received_at     timestamptz not null default now(),
  processed_at    timestamptz,
  payload         jsonb not null
);

-- Decision aggregates: per-minute rollup. Valid SQL (one PK, unique constraint,
-- non-null dimension via sentinel '').
decision_aggregates (
  id              bigserial pk,
  tenant_id       uuid not null references tenants(id),
  edge_node_id    uuid not null,
  bucket_minute   timestamptz not null,
  dimension_kind  text not null,           -- all | principal | fingerprint
  dimension_value text not null,           -- '' for 'all'; the principal_id or fingerprint otherwise
  action          text not null,            -- allow | deny | passthrough
  count           integer not null,
  unique (tenant_id, edge_node_id, bucket_minute, dimension_kind, dimension_value, action)
);
-- High-volume table: composite FKs deliberately omitted for write throughput.
-- Tenant isolation enforced at the authz layer.

-- Decision samples: all denies + tunable % of allows/passthroughs
decision_samples (
  id              bigserial pk,
  tenant_id       uuid not null references tenants(id),
  edge_node_id    uuid not null,
  wal_seq         bigint not null,
  fingerprint     text not null,
  principal_id    text,
  score           integer,
  blacklisted     boolean,
  score_reason    text,
  action          text not null,
  decided_at      timestamptz not null,
  received_at     timestamptz not null default now(),
  unique (edge_node_id, wal_seq)
);

-- Batch receipt (idempotent delivery)
decision_batches (
  edge_node_id    uuid not null,
  batch_id        uuid not null,           -- from the edge
  tenant_id       uuid not null references tenants(id),
  first_wal_seq   bigint not null,
  last_wal_seq    bigint not null,
  payload_hash    text not null,           -- sha256(batch payload); rejects duplicate batch_id with different contents
  received_at     timestamptz not null default now(),
  primary key (edge_node_id, batch_id),
  CHECK (first_wal_seq <= last_wal_seq)
);
-- The control plane applies aggregate increments + samples in the SAME
-- transaction as the decision_batches insert. Re-delivery of the same
-- (edge_node_id, batch_id) is a no-op; a duplicate batch_id with a different
-- payload_hash is rejected (409).

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

Application-level in v1. `authz/` injects `WHERE tenant_id = $1` on tenant-scoped tables. Global graph tables are cross-tenant by design (scores, principals, attestations). **Not a score-visibility boundary** — all tenants see all network scores. **Participant facts are tenant-restricted**: `visibility = 'participants'` facts visible only to the issuer's `owner_tenant_id`, the subject's `owner_tenant_id`, and staff. Composite FKs on `edge_nodes.api_key_id`, `sync_cursors.edge_node_id`. `decision_*` tables are high-volume; FKs omitted for throughput, isolation at the authz layer.

### 5.4 Multi-tenancy model

Row-level isolation, shared schema. Self-hosted = single tenant. Enterprise = own self-hosted deployment. One code path.

### 5.5 Data retention and privacy

- **Retention:** attestations are retained until the later of (a) `expires_at` and (b) the issuing issuer's deactivation date + 1 year. **All combinations spelled out:**
  - `expires_at` set, issuer active: retain until `expires_at`.
  - `expires_at` null, issuer active: retain indefinitely (until issuer deactivates, then +1 year).
  - `expires_at` set, issuer deactivated: retain until `expires_at` (if still future) or deactivation + 1 year, whichever is later.
  - `expires_at` null, issuer deactivated: retain until deactivation + 1 year.
  After retention, attestations are **deleted** (not tombstoned).
- **Subject deletion:** the principal is **deactivated** (`status = 'deactivated'`, `deactivated_at = now()`), removed from active scoring. `name` and `metadata` are cleared. The cryptographic record is preserved or deleted **per an explicit legal basis** — not relabeled. Combining subjects into a tombstone is avoided (graph integrity). **Deactivation is an UPDATE, so `ON DELETE CASCADE` does not fire** — the control plane **explicitly deletes** the principal's `network_scores` and `network_score_history` rows and emits `score.delete` sync events. History is handled according to the counsel-approved retention basis (preserved or deleted per legal basis, not merely relabeled).
- **`/v1/privacy/export` and `/v1/privacy/delete`** are workflow initiators, not compliance certifications. **Privacy counsel validates in two stages**: (1) the retention/erasure model reviewed **before step 6** (schema freeze); (2) counsel sign-off **before step 17** (first real personal data ingest).
- **`facts` never written to logs.** Redaction at every egress. `visibility = 'participants'` facts visible only to issuer-owner, subject-owner, and staff.
- **One attestation = one visibility.** No field-level mixed visibility. **Split-visibility via `observation_id`:** if an issuer needs some facts public and some participant-only, it issues two attestations with the same `observation_id`. Scoring groups by `(issuer_id, subject_id, observation_id)` and counts **at most one edge per group** (the most restrictive visibility). Paired attestations must agree on `attestation_type` and `trust_delta` (enforced by the control plane; mismatch → 4xx).
- **`facts_hash` = SHA-256(RFC 8785 JCS(facts))** — exact-content identity. JCS specifies number/string/Unicode normalization. Cross-language fixtures in CI. Not used to group public/private variants (that's `observation_id`); used for exact-content dedup alongside `token_digest`.
- Decision aggregates: 90 days (pro) / 1 year (enterprise). Decision samples: 30 days (pro) / 90 days (enterprise). Audit log: 90 days (pro) / 1 year (enterprise).

---

## 6. Security

| Concern | Measure |
|---|---|
| **Request authentication** | HTTP Message Signatures (RFC 9421) + Content-Digest (RFC 9530). Covered: `@method`, `@target-uri`, `content-digest`, `Idempotency-Key` (when required). 128-bit nonce, replay cache. `key_hash` = SHA-256 over raw 32-byte Ed25519 public key, derived after verification. Cross-edge replay accepted for non-Idempotency-Key endpoints; Idempotency-Key endpoints protected by backend uniqueness. |
| **Invalid vs. absent signature** | Absent → `unsigned_action` (passthrough/deny). Present but malformed/unknown/expired/replayed/unverifiable → 401/403. Never passthrough. |
| **Attestation verification** | Ed25519. Control plane pre-parses JWS for `iss`/`kid`/`iat`, resolves candidate keys from `principal_keys` valid at `iat`, supplies `{key_id, public_key}` candidates. `kid` required for native v1; candidate-key trial is legacy fallback. Returns `verified_key_id`. Composite FK `(issuer_id, verified_key_id) → principal_keys`. |
| **API key storage** | HMAC-SHA256. No legacy column. Format `vrl_` + 64 lowercase hex. |
| **Tenant isolation** | Application-level. Global graph cross-tenant. Participant facts tenant-restricted. |
| **RBAC scopes** | `attest:write`, `attest:read`, `sync:read`, `policy:admin`, `tenant:admin`, `billing:read`. |
| **Rate limiting** | Per-tenant by plan. Sync exempt. |
| **Edge auth** | Tenant API key over TLS. mTLS deferred. |
| **Customer private keys** | Never enter VeriLink. Only public keys stored. Bootstrap signing key in KMS/HSM. |
| **Audit** | `audit_log` for admin events. Decisions → aggregates + samples. |
| **Replay protection** | Attestations: `iat`/`exp`, dedup on `token_digest`. Requests: nonce cache + `Idempotency-Key` (where required). |
| **Fail-closed edge** | Unknown principal → score 0, policy default. Stale beyond `max_snapshot_age_seconds` → 503 (or fail-open if `fail_open_expired`). |
| **`trust_delta` range** | `CHECK (trust_delta BETWEEN -100 AND 100)` + sign constraint (negative only for `negative_incident`). |
| **Key uniqueness** | Global `UNIQUE(key_hash)` — one key belongs to at most one principal, even across rotation/validity windows. |

### 6.1 Abuse and Sybil resistance

VeriRank propagates trust **only from roots of trust**. Sock-puppet issuers get zero score (unrooted).

- **Issuer verification:** `issuers.verified_at` after proof of key control (`principal_keys.control_verified_at`) + review. Unverified → `trust_weight = 0`.
- **Agent ownership proof:** registration requires signing a challenge (sets `control_verified_at`).
- **Attestation taxonomy + schema:** control plane validates `attestation_type` + versioned facts schema. Unknown → 4xx.
- **`trust_delta` constraints:** `[-100, 100]`; negative only for `negative_incident` (CHECK).
- **Negative-report moderation:** `negative_incident` from an issuer with score ≥ 80 → `blacklisted = true`. Disputes flag for staff, no auto-revoke.
- **Key revocation:** `principal_keys.revoked_at`; `key.revoke` sync event.
- **Attestation supersession:** `superseded_by` chain.
- **Visibility:** attestation-level `participants | public`. Split-visibility via `observation_id` (5.5).
- **Bootstrap de-emphasis:** stepwise `Root.weight` reduction (1.0 → 0.5 → 0.25 → removal), each step requiring a counterfactual removal report (no principal's score drops below its serving tenant's threshold solely due to the step) and staff approval. **`Root.weight` is the only de-emphasis path**; `issuers.trust_weight` stays 1.0 for bootstrap issuers (it's the orthogonal issuer-quality knob). **Trigger:** ≥3 independent verified organic issuers, ≥80% organic weighted contribution for 30 days, counterfactual removal report — manual, not automatic. The seeder writes `current_weight` through to `Root.weight` (not `issuers.trust_weight`).

### 6.2 JA4 and TLS termination

- **Edge terminates TLS:** full JA4.
- **Behind an existing LB/Cloudflare:** JA4 unavailable. Fingerprint collapses to `headers_hash + key_hash + protocol`. `X-Verilink-Fingerprint-Mode: full | degraded`.
- **Identity continuity:** identity is resolved from the verified `keyid`, not the fingerprint. The fingerprint is diagnostic only.

### 6.3 Whimsy compatibility

1. `behavioral` added to the enum.
2. Dedup on `token_digest` (no `jti` needed).
3. `schema_version`: Whimsy's payload has none → defaults to `"0"`, validated as `behavioral@0`. **Allowlisted legacy exception**: `@0` accepted only from explicitly allowlisted legacy issuer IDs (initially Whimsy's). New issuers cannot adopt `@0`. **`BEHAVIORAL_V0_CUTOFF`** config = GA + 183 days; startup fails if GA mode is enabled without it. After cutoff, `@0` returns 422. Whimsy migrates to `behavioral@1` at launch.
4. `visibility`: Whimsy has none → defaults to `participants`.
5. `iss`/`sub`: Whimsy uses `did:key:whimsy-system` and a `remoteFingerprint` hash. Control plane accepts legacy DIDs/strings, creates `vrl:p:<uuid>` lazily, records the original in `metadata.legacy_did`.

### 6.4 Per-type facts schemas

Versioned JSON Schemas in `docs/specs/`, required before ingest. `schema_version` mandatory for native v1; `additionalProperties: false` for typed schemas. Max 8 KB, depth 4.

- `transaction_summary@1`: observation window (start, end), success count, failure count, dispute count.
- `kyb@1`: status, verifier, jurisdiction, verification timestamp, expiry timestamp.
- `security_audit@1`: standard, result, auditor, report digest, audit timestamp.
- `negative_incident@1`: category, severity, occurrence timestamp, evidence digest.
- `behavioral@0`: Whimsy's current shape (`{ action, ... }`, `additionalProperties: true`). Allowlisted legacy only.
- **`behavioral@1`**: schema URI (`"https://verilink.io/schemas/behavioral@1.json"`), observation timestamp, bounded issuer-defined data object (`additionalProperties: true`, max 4 KB nested). Required fields: `observation_ts`. Whimsy migrates to this at launch.

Facts never feed VeriRank — only `trust_delta` does.

---

## 7. Error handling

### 7.1 Edge (`edge-verifier`, Go)

Five distinct states:

| State | Definition | Behavior |
|---|---|---|
| **Unknown principal** | Verified signature, but no score row for the principal | Score 0, `score_reason` absent (no row), policy `below_threshold_action`. Common case. |
| **Unsigned** | **Neither** `Signature` **nor** `Signature-Input` header present | `policy.unsigned_action`: `passthrough` (proxy, `X-Verilink-Status: Unverified`) or `deny` (403). Default `passthrough`. |
| **Invalid signature** | `Signature` or `Signature-Input` present (incomplete pair, malformed, unknown `keyid`, expired, replayed, or unverifiable) | **401/403**, `X-Verilink-Status: Denied`, `X-Verilink-Reason: invalid-signature \| unknown-key \| expired \| replayed`. **Never passthrough.** A present-but-incomplete header pair is an authentication attempt, not an unsigned request. |
| **Degraded (stale)** | Time since last authenticated SSE bytes (heartbeat or event) > `max_snapshot_age_seconds` (default 300, tunable 60–1800) | 503, `X-Verilink-Mode: stale` — unless `fail_open_expired = true`, then serve with `X-Verilink-Mode: expired`. |
| **Degraded (unreachable, contact fresh)** | Sync unreachable, last authenticated bytes within `max_snapshot_age_seconds` | Serve snapshot, `X-Verilink-Mode: degraded`. Retry 1s → 30s. |

Freshness is **time since last authenticated bytes on the stream** (heartbeats are `: ping` comments every 30s). The in-memory snapshot is an **immutable map** (atomic swap). A cache miss means "unknown," never "fall back to an older snapshot."

### 7.2 Control plane (`control-plane` TS)

Structured errors. Attestation ingest: signature + schema verified synchronously; storage transactional; only score recomputation enqueued. **No attestation sync event written** (score recomputation emits the edge-visible event). Invalid → deterministic 4xx. `RunVeriRank` failures retry 3x then dead-letter; `network_scores` stays at last-good; dashboard staleness warning after 1h.

**Decision ingestion:** edge writes decisions to a bounded local WAL with per-edge `wal_seq`. Flushes in batches with a `batch_id` + `payload_hash`. **WAL full → drop oldest + increment `decisions_dropped_total`** (default; alerted at 70/85/95% of `wal_max_bytes`, default 256 MiB). Enterprise `no_drop_decisions` blocks when WAL full (opt-in; `wal_max_bytes` default 8 GiB, sized via `ceil(p99_wal_bytes/s × required_outage_seconds × 1.5)`, default `required_outage_seconds = 900` — **independent of `max_snapshot_age_seconds`**). The control plane applies aggregate increments + samples in the **same transaction** as the `decision_batches` insert (idempotent on `(edge_node_id, batch_id)`; duplicate `batch_id` with different `payload_hash` → 409).

**Sampling:** all denies + `allow_sample_rate` × allows/passthroughs (default 0.010).

### 7.3 Trust engine

Stateless gRPC. Idempotent `RunVeriRank` given same inputs + `evaluation_time`. Panics caught at handler boundary.

### 7.4 Failure notifications

Sentry + Prometheus/Alertmanager. `decisions_dropped_total` is an alert. No n8n error-workflow.

---

## 8. Observability

| Signal | Source | Tool |
|---|---|---|
| Metrics | `edge-verifier` (local decision overhead, excluding upstream; allow/deny/passthrough/invalid counters; cache hit rate; WAL depth; `decisions_dropped_total`; SSE bytes age; seconds-to-WAL-full), `control-plane`, `trust-engine` | Prometheus + Grafana |
| Logs | Structured JSON. **`facts` never written to logs.** | Loki/CloudWatch |
| Traces | OpenTelemetry, all three languages. | OTLP → Tempo/Jaeger |
| Error tracking | Sentry | Sentry |
| Internal dashboards | Graph size, VeriRank lag, edge health, `decisions_dropped_total` | Grafana |
| Tenant dashboards | Aggregated counters + sampled feed; score history | Product dashboard (recharts) |
| Healthchecks | `/healthz` on all three | K8s probes |

---

## 9. Testing

| Layer | Approach |
|---|---|
| **Go core (`pkg/*`)** | Existing tests + property-based (decay invariants, monotonicity, unrooted-cluster zero-score, `trust_weight`, `evaluation_time` determinism). **3-hop transitive contract test**: root → A → B → C, assert C scores non-zero (guards the unified namespace). gRPC contract tests for `cmd/trust-engine`. |
| **Go edge** | Integration: signed + unsigned + invalid + unknown + passthrough requests, assert status + headers. **`VR-002` is a dedicated-hardware nightly-staging gate**, local decision overhead only. **First step: Go baseline benchmark** (`scripts/benchmark-baseline.sh`). **Path-swap replay test**: capture a signed request, replay with a different path, assert 401 (guards `@target-uri` coverage). |
| **TS control plane** | Jest. Unit tests for adapted modules. Integration against Postgres + Redis. Contract tests against gRPC trust engine. |
| **TS dashboard** | Vitest + Playwright. Golden path: onboard, register, attest, score, policy. |
| **Cross-language parity (post-v1)** | `scripts/parity-check.sh`: fixture corpus + Go golden hashes locked in CI. Rust must match to graduate. **v1 has no cross-language parity criterion.** |
| **Load** | k6 against `edge-verifier`, nightly staging. |
| **Security** | `semgrep`, secret scan. |

---

## 10. Deployment

### 10.1 Artifacts

- `docker/Dockerfile.edge` (Go, distroless, `CGO_ENABLED=0`), `Dockerfile.control-plane`, `Dockerfile.trust-engine`.
- `docker/docker-compose.self-host.yml` — all three + Postgres + Redis.
- `helm/` — configurable `edge.kind`. Control-plane + trust-engine Deployments with HPAs. Postgres + Redis upstream charts.
- `systemd/verilink-edge.service` + sample config.
- **Static binary releases:** x86_64 + aarch64, `CGO_ENABLED=0`, GitHub Releases with checksums, SBOM, signed releases.

### 10.2 Local dev

`scripts/dev-up.sh` — Docker Compose all services + Postgres + Redis, seed bootstrap registry.

### 10.3 Hosted SaaS

OCI `ca-toronto-1` (Toronto), co-located with Whimsy/Codero. `VERILINK_MULTI_TENANT=true`. Single region. Postgres daily snapshots + WAL archiving; **quarterly restore drill**; RPO/RTO verified. **Zero-downtime deploys are a hard requirement**: with the default 5-minute `max_snapshot_age_seconds`, every fail-closed customer 503s if the control plane is down >5 min during a deploy. Rolling restarts with health-gated traffic shifting.

### 10.4 Docs site

Docusaurus, versioned, MDX + OpenAPI/Redoc.

---

## 11. Dashboard

Vite SPA, Numera/Whimsy kit. Served by control plane.

### 11.1 Provider view

- Trust-score summary: aggregated allow/deny/passthrough counters (recharts), top agents, top denied fingerprints.
- Sampled decision feed.
- Agent list with canonical scores, `blacklisted`, `score_reason`.
- Policy editor: threshold, `below_threshold_action`, `unsigned_action`, allow/deny fingerprint lists, `fail_open_expired`, `no_drop_decisions`, `max_snapshot_age_seconds`, `allow_sample_rate`.
- API key management.
- Edge-node sync status (last sync version, bytes age, `stale`).
- Billing portal links.

### 11.2 Agent-builder view

- Registered principals (by `vrl:p:<uuid>` + key IDs + derived assurance).
- Attestation feed (incoming + outgoing) with `visibility` and `observation_id` pairing indicator.
- Trust score over time (recharts).
- Issuer relationships.
- Billing.

### 11.3 Admin view

- Bootstrap registry editor: `current_weight`, `de_emphasis_reason`, `approved_by`. Signal: ≥10× ratio (surface); locked trigger: ≥80% organic + 3 issuers (6.1).
- Tenant list.
- Graph health.
- Issuer verification queue.

### 11.4 Graph visualization (v1)

Read-only summaries only: node/edge counts, top issuers by outgoing volume. No path-summary cards. No interactive explorer.

---

## 12. Clients

| Client | v1 action |
|---|---|
| `client/go` | Add HTTP Message Signature signing (incl. `Idempotency-Key` coverage); update default URL. |
| `client/node` | npm publish as `@verilink/node` with TS types + signing. |
| `client/rust` | Deferred (post-v1). |

---

## 13. v1 scope and sequencing

1. **Go baseline benchmark** (`scripts/benchmark-baseline.sh`) — first gate.
2. **Privacy counsel review (stage 1)** — review retention/erasure model (5.5) **before** step 6.
3. **Monorepo restructure + CI** — directory layout, CI for Go + TS, parity harness scaffold (Go-only).
4. **Engine fixes** — `evaluation_time` determinism, `trust_weight` (bootstrap stays 1.0), `blacklisted` + `score_reason` (`propagated|blacklisted`), weighted roots (`Root { id, weight }`), max-path documentation. 3-hop contract test.
5. **Trust-engine gRPC** — client-streamed `RunVeriRank` with `Principal` rows, `VerifyAttestation` with `{key_id, public_key}` candidates returning `verified_key_id`, `GetFingerprint`.
6. **Control-plane TS foundation** — adapt Whimsy's `db/`, `middleware/`, `authz/`, `shared/`. Express + healthcheck. **Migrations (schema frozen after this step).**
7. **Data model + domains** — schema in Section 5. `tenant`, `registry`, `graph`, `policy`, `bootstrap`, `billing`, `events`, `sync`.
8. **Request-auth protocol** — HTTP Message Signature verification in the Go edge; `@target-uri` coverage; `external_base_url`; nonce replay cache; `Idempotency-Key` coverage; `/.well-known/verilink`. Signing helpers in Go + Node. **Path-swap replay test.**
9. **Attestation ingest end-to-end** — pre-parse JWS for `iss`/`kid`/`iat`, candidate keys, synchronous verify, schema validation, `trust_delta` CHECK, dedup on `token_digest`, `observation_id` pairing, lazy principal creation, `kid` required (legacy fallback). **No attestation sync event.**
10. **Network score computation** — global VeriRank (chunked, `Principal` rows), hourly periodic recompute, `observation_id` grouping, write to `network_scores` (FK CASCADE DEFERRABLE) + `network_score_history` (on change), append to `sync_events` (same transaction).
11. **Sync event log + edge sync** — transactionally safe `sync_version`, snapshot (repeatable-read, `high_water_version`, gzip/zstd), SSE stream with `: ping` heartbeats + non-durable cursor events, `410 Gone` on pruned cursor, per-tenant filtering. No `alias.*` events.
12. **Go edge hardening** — HTTP Message Signatures, three-way outcome (invalid → 401/403, never passthrough), versioned sync client, atomic in-memory snapshot, bounded local WAL (drop-oldest + counter; enterprise no-drop with `payload_hash` + CHECK), atomic disk snapshots, `decisions_dropped_total`.
13. **Dashboard** — fork the kit; provider + agent-builder + admin views; read-only graph summaries; Stripe portal links.
14. **Bootstrap registry + cold-start seed** — curate root-of-truth; seed script; derive `is_bootstrap`; stepwise de-emphasis mechanism (`Root.weight` only).
15. **Deployment artifacts** — Dockerfiles, Helm, systemd unit, static binary releases.
16. **Clients** — publish Node to npm; update Go client with signing.
17. **Whimsy integration migration** — point `shared/verilink.js` at hosted control plane; `behavioral@0` allowlist; lazy `vrl:p:` IDs; migrate to `behavioral@1`. **Privacy counsel sign-off (stage 2) required before this step.** **`BEHAVIORAL_V0_CUTOFF` set.**
18. **Codero reference deployment** — guard `POST /memory/observations`; OpenCode/Codex session signs requests via OS keychain; `Idempotency-Key` mandated + covered + backend uniqueness.
19. **Docs site** — Docusaurus; schema refs, quickstarts, integration guides, self-host guide, deprecation page.
20. **Backup/restore drill** — quarterly Postgres restore; RPO/RTO verified.

---

## 14. Out of scope for v1

- Rust edge verifier + Rust client (post-v1 parity harness).
- Decentralized DID resolution beyond `did:key` verification methods.
- Per-tenant issuer weighting.
- `challenge` action.
- Interactive trust-graph explorer + path-summary cards.
- Embeddable reputation badge.
- Non-HTTP protocols at the edge.
- Mobile dashboard.
- SSO/SAML (OIDC only).
- mTLS for edge-to-control-plane.
- Metered/usage-based billing.
- Multi-region hosted deployment.
- PostgreSQL Row-Level Security.
- `correlated_behavioral` assurance level (removed).
- `unsigned_max_score` cap (removed).
- `facts_private` (removed).
- Alias map + `agent_fingerprints` table + `alias.*` sync events (removed — identity from `keyid` directly).
- `behavioral@0` for new issuers (allowlisted legacy only; `BEHAVIORAL_V0_CUTOFF`).
- Cross-language parity (v1 is Go-only).
- Automatic bootstrap de-emphasis (manual, metric-gated).
- In-band algorithm downgrade negotiation.
- Field-level facts visibility.
- `score_reason: verified` (removed — redundant with `propagated`).
- `score_reason: unknown` as a stored value (unknown = no row).

---

## 15. Resolved review decisions

All review questions are resolved; no open questions remain.

1. **`behavioral@0` deadline** — `BEHAVIORAL_V0_CUTOFF` config = GA + 183 days (mechanism, not an invented date).
2. **No-drop `required_outage_seconds`** — default 900s, independent of `max_snapshot_age_seconds`; `wal_max_bytes = max(8 GiB, calculated)`.
3. **Codero `Idempotency-Key`** — mandated; covered in the signature; backend enforces uniqueness (same key + same digest = original result, same key + different digest = 409).
4. **Dedup key form** — `facts_hash` = SHA-256(RFC 8785 JCS) for exact-content identity; split-visibility grouping via `observation_id` (not `facts_hash`).
5. **`network_scores` FK** — in v1: FK to `principals` `ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED`.

---

## 16. Success criteria for v1

- [ ] A provider can sign up, get an API key, run the Go `edge-verifier`, and receive allow/deny/passthrough decisions on signed and unsigned traffic in under 15 minutes.
- [ ] **Go baseline benchmark** passes: 10k req/s, sub-millisecond p99 local decision overhead, on a pinned nightly-staging runner.
- [ ] An agent builder can register a principal, attach a key, sign requests with HTTP Message Signatures (incl. nonce + `@target-uri`), receive an attestation, and see a non-zero trust score.
- [ ] **3-hop transitive contract test passes**: root → A → B → C, C scores non-zero.
- [ ] **Path-swap replay test passes**: a captured signed request replayed with a different path returns 401 (guards `@target-uri` coverage).
- [ ] **Invalid-signature test passes**: a malformed/unknown/expired/replayed signature returns 401/403, never passthrough.
- [ ] The bootstrap registry is seeded; providers see a non-empty graph on first sync.
- [ ] Whimsy's `behavioral@0` attestations appear in the graph and dedup on `token_digest`; Whimsy is on the `@0` allowlist; `BEHAVIORAL_V0_CUTOFF` is set.
- [ ] Codero's `POST /memory/observations` is guarded: a signed OpenCode/Codex session with covered `Idempotency-Key` is allowed; unsigned is denied; same key + different digest = 409. The session's private key is in the OS keychain.
- [ ] Self-hosted `docker-compose.self-host.yml` works with no manual SQL.
- [ ] The Node client is published to npm with signing support.
- [ ] `audit_log` records admin events; `decision_aggregates` + `decision_samples` record edge decisions via the bounded local WAL with idempotent batch delivery (`(edge_node_id, batch_id)` + `payload_hash`). **Dropped decisions are counted via `decisions_dropped_total` and alerted on — no silent loss.** Enterprise no-drop blocks when WAL full (opt-in).
- [ ] All three services have healthchecks wired to K8s probes.
- [ ] Postgres restore drill passes; RPO/RTO verified.
- [ ] `blacklisted` and `score_reason` are surfaced on the dashboard and in edge response headers, not inferred from `score == 0`.
- [ ] The unified sync event log propagates score, key-upsert, key-revoke, and policy changes to connected edges via SSE within one minute. Heartbeats are `: ping` keepalives, not durable rows. Non-durable cursor events advance `Last-Event-ID` across tenant-filtered gaps.
- [ ] Privacy counsel has signed off (stage 2) before the Whimsy migration ingests real personal data.
- [ ] `trust_delta` CHECK constraint rejects values outside `[-100, 100]` and positive `negative_incident` deltas.
- [ ] `trust_graph.md` documents the max-path algorithm (not weighted-average).