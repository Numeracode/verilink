# VeriLink Productization Design

- **Status:** Draft v4 — review round 3 findings incorporated
- **Date:** 2026-07-25 (v4: 2026-07-25)
- **Owner:** Sanjay
- **Repo:** `/srv/storage/repo/VeriLink/`
- **Related specs:** [`docs/specs/attestation_schema.md`](../../specs/attestation_schema.md), [`docs/specs/fingerprinting.md`](../../specs/fingerprinting.md), [`docs/specs/trust_graph.md`](../../specs/trust_graph.md)
- **Related roadmap:** [`ROADMAP.yml`](../../ROADMAP.yml) (MVP Phase 0 — all six tasks complete)

---

## Change log

- **v2:** Global trust graph; corrected gRPC fingerprint contract; honest engine-work accounting; Go edge in v1; decision/audit split; token-digest dedup; identity assurance levels; Sybil resistance; JA4/TLS termination.
- **v3:** Request-authentication protocol (HTTP Message Signatures); stable VeriLink IDs (rotation-capable); schema corrections (composite FKs, `bootstrap_registry` split); score semantics (`blacklisted` + `score_reason`); unified sync event log; privacy deletion model (deactivate, not tombstone); WAL drop-oldest; aggregate + sampled decisions; `MAX_SNAPSHOT_AGE` keyed to heartbeat; stepwise bootstrap de-emphasis; OCI `ca-toronto-1`; versioned facts schemas; attestation-level visibility.
- **v4:** Resolves round-3 blocking findings: **unified `principals` table** (B1 — transitive trust requires issuer and subject to share one namespace, matching `pkg/trust/engine.go`'s single-string keying); **three-way request outcome** (B2 — signed+verified / unsigned-passthrough / unsigned-denied, no `unsigned_max_score` cap); corrected **RFC 9421 signature profile** (nonce, 128-bit, replay cache, `key_hash` over raw 32-byte key, `external_base_url`); **verification keys in sync** (key.upsert + key.revoke); **transactionally safe `sync_version`** (locked allocator in the same transaction as state mutation); **periodic recompute** (hourly, time decay advances); **kid in v1** (JWS `kid` required for native submissions); **`facts_private` removed** (attestation-level visibility only); **`trust_delta` range constraints** (negative only for `negative_incident`); **decision rollup dimension explicit** + **batch-receipt idempotent delivery**; **missing policy columns** (`fail_open_expired`, `no_drop_decisions`, `max_snapshot_age_seconds`, `allow_sample_rate`); **`Root { id, weight }`** in VeriRank (weighted bootstrap); **heartbeat as SSE keepalive** (not durable log rows); **3-hop contract test** added to Section 9; behavioral@0 sunset to allowlist + 6-month deadline; no-drop WAL derived formula (8 GiB default); `/.well-known/verilink` capability discovery; gzip (mandatory) + zstd (optional) via Accept-Encoding; privacy counsel in two stages (pre-schema + pre-ingest); `agents.assurance_level` derived; zero-downtime deploy requirement noted.

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

**Providers** run the Go edge verifier in front of their API. The verifier handles three request outcomes (4.3): signed+verified (resolve identity, score, threshold policy), unsigned-passthrough (proxy with no trust verdict — the default for general APIs serving humans and ordinary clients), and unsigned-denied (per-policy, for pure agent endpoints). Providers pay for the hosted control plane.

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
| Trust graph partitioning | Global graph; tenant-scoped policy/ownership only | Canonical scores are network-wide; tenants apply thresholds as a policy overlay. **Tenants are not a *score-visibility* boundary; participant facts are tenant-restricted.** |
| **Principal identity model** | **Unified `principals` table; one namespace `vrl:p:<uuid>` for agents and issuers** | VeriRank keys scores by a single string — an entity that receives trust as a subject must pass it on as an issuer under the same ID. Split namespaces collapse transitive propagation to one hop. Matches `pkg/trust/engine.go`. |
| Request authentication | HTTP Message Signatures (RFC 9421) + Content-Digest (RFC 9530), with nonce replay cache | Every signed request proves possession. `key_hash` = SHA-256 over the raw 32-byte Ed25519 public key, derived after verification. |
| Request outcomes | **Three-way: signed+verified / unsigned-passthrough / unsigned-denied** | General APIs serve humans who never sign — passthrough is the default. Pure agent endpoints (Codero) deny unsigned. No `unsigned_max_score` cap. |
| Edge stack (v1) | Go (the existing edge-verifier), gated on a fresh baseline benchmark | First implementation step produces the `VR-002` artifact; revisit if it fails |
| Edge stack (post-v1) | Rust behind FFI parity harness | After byte-identical fingerprints proven |
| Control-plane stack | TypeScript (reusing Numera/Whimsy) | Maximal reuse |
| Trust-core algorithms | Stay Go, exposed via gRPC | Avoids a third reimplementation |
| `kid` in JWS | **In v1** (required for native submissions; allowlisted legacy exception for Whimsy) | Enables explicit key selection; candidate-key-by-iat trial is the legacy fallback |
| `facts_private` | **Removed** | Conflicts with attestation-level `visibility`. One attestation = one visibility. |
| `trust_delta` constraints | **Negative only for `negative_incident`; nonnegative for other types** | Prevents accidental blacklisting via positive types |
| Graph cold-start | VeriLink-seeded root of trust | Empty graphs kill adoption |
| Bootstrap de-emphasis | **Manual, metric-gated; `Root { id, weight }` in VeriRank** | Stepwise weight reduction with rollback. Trigger: ≥3 independent verified organic issuers, ≥80% organic weighted contribution for 30 days, counterfactual removal report. |
| Repo structure | Single monorepo | Small team |
| OIDC provider | Clerk via OAuth Application + Authorization Code/PKCE + Account Portal, against generic OIDC (`openid-client`) | Not the Clerk session SDK |
| Billing | Stripe Billing, fixed-tier subscriptions | Defer metered |
| Docs generator | Docusaurus | React/TS alignment |
| Hosted region | OCI `ca-toronto-1` (Toronto) | Co-located with Whimsy/Codero |
| Static edge binary | Yes | Linux x86_64 + aarch64, `CGO_ENABLED=0`, systemd unit, checksums, SBOM, signed releases |
| Graph visualization (v1) | Read-only summaries only | Node/edge counts, top issuers. No path-summary cards (require cut data). No interactive explorer. |
| Reputation badge | Post-v1 | Marketing surface |
| Challenge action | Cut from v1 | allow/deny (and passthrough) only |
| Behavioral@0 | **Sunset: 6-month deadline, allowlisted legacy issuers only (initially Whimsy), 422 after cutoff** | |
| No-drop WAL | **Default 8 GiB; formula `ceil(p99_wal_bytes/s × required_outage_seconds × 1.5)`** | Sized to ~15 min at 10k 500-byte deny samples/s. `MAX_SNAPSHOT_AGE` does not bound a telemetry-only outage. |
| Capability discovery | **`GET /.well-known/verilink`** returns protocol version, signature/digest algorithms, required components, nonce requirement, max age, skew | v1 accepts only ed25519; future algorithms require overlap + client min-policy pinning |
| Snapshot compression | **gzip mandatory, zstd optional via Accept-Encoding** | gzip is stable + dependency-free in Node 24; zstd preferred when both advertise |
| Privacy counsel | **Two stages: pre-schema (before step 6) + pre-ingest (before Whimsy migration, step 17)** | Erasure depends on legal basis; cannot safely remain a late gate |

---

## 4. Architecture

### 4.1 Monorepo layout

```
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
| `edge-verifier` (v1) | Go | 8080 (data), 9090 (admin) | Reverse proxy. Three-way outcome (signed+verified / unsigned-passthrough / unsigned-denied). Verifies HTTP Message Signature, derives key hash, resolves canonical principal, looks up local trust cache, allow/deny/passthrough. Pulls sync event stream. |
| `control-plane` | TypeScript (Express) | internal HTTP behind ingress; gRPC to trust-engine | Multi-tenant API: principal/agent/issuer registry, attestation submit/verify, sync event log + snapshot, policy, API keys, onboarding, billing. |
| `trust-engine` | Go (gRPC) | 9091 | Stateless VeriRank + attestation verify + fingerprint. |
| `dashboard` | TypeScript (Vite SPA) | served by control-plane | Provider + agent-builder + admin views. |

Postgres (durable source of truth), Redis (sync buffer, rebuilt from Postgres; rate limits). Edge is local-memory only.

Edge deployment topology is configurable (`edge.kind`: DaemonSet | Deployment | static binary + systemd unit).

### 4.3 Request authentication and outcomes

**Three-way outcome model:**

| Outcome | Trigger | Behavior |
|---|---|---|
| **Signed + verified** | Valid HTTP Message Signature for a registered key | Resolve canonical principal, look up score, apply threshold policy → `allow`/`deny`. `X-Verilink-Status: Allowed\|Denied`. |
| **Unsigned passthrough** | No signature (or invalid), policy `unsigned_action = passthrough` (the **default**) | Proxy to backend with `X-Verilink-Status: Unverified`. No trust verdict. The default for general APIs serving humans and ordinary clients. |
| **Unsigned denied** | No signature, policy `unsigned_action = deny` | 403, `X-Verilink-Status: Denied`, `X-Verilink-Reason: unsigned`. For pure agent endpoints (Codero's `POST /memory/observations`). |

There is **no `unsigned_max_score` cap** — unsigned traffic gets no score. The cap feature is removed (it was incoherent: unsigned requests have no key hash and thus no alias correlation).

**HTTP Message Signature profile (RFC 9421 + RFC 9530), corrected:**

```http
Signature-Input: sig1=("@method" "@authority" "content-digest");created=<unix>;keyid="<vrl:p:<uuid>#<key-id>";alg="ed25519";nonce="<128-bit-hex>"
Signature: sig1=:<base64-signature>:
```

- **Covered components:** `@method`, `@authority`, `content-digest` (for requests with bodies). `@authority` is the externally-visible authority; `@target-uri` is redundant with `@method` + `@authority` + the request target and is omitted.
- **`created`** is a **signature parameter**, not a covered component. Accepted window: `created` up to 30 seconds in the future (skew tolerance) and no more than 5 minutes in the past.
- **`nonce`** is a 128-bit hex random value, unique per `(keyid, nonce)` within the acceptance window + skew. The edge maintains a replay cache for at least the window + skew (5 min + 30 s).
- **`keyid`** is `<vrl:p:<uuid>#<key-id>`.
- **`key_hash` derivation:** `SHA-256` over the **raw 32-byte Ed25519 public key** (not serialized JWK JSON). Computed by the edge after successful signature verification; caller-supplied key hashes are ignored.
- **Behind a TLS-terminating LB:** the edge must reconstruct the externally-visible target URI to verify. The edge config has an `external_base_url` field (e.g. `https://api.example.com`) used to derive `@authority` and the request target. Without it, verification fails on misconfigured deployments (the spec states this).
- **Cross-edge replay:** within the 5-minute `created` window, a captured signed request replays successfully against a *different* edge node (the nonce cache is edge-local). **v1 accepts this** — idempotency is the provider backend's concern. For non-idempotent provider endpoints, providers may require a signed `Idempotency-Key` header (covered by the signature); the spec recommends this but does not mandate it.

**Capability discovery:** `GET /.well-known/verilink` returns:
```json
{
  "params_version": 1,
  "signature_algorithms": ["ed25519"],
  "digest_algorithms": ["sha-256"],
  "required_components": ["@method", "@authority"],
  "nonce_required": true,
  "max_age_seconds": 300,
  "max_skew_seconds": 30
}
```
v1 accepts only `ed25519`. Future algorithms require an overlap window and client minimum-policy pinning; the document itself versions via `params_version`.

**Client signing support:** the Go and Node clients gain a signing helper. The agent's private key is supplied by the caller and never sent to VeriLink.

### 4.4 Identity model

**Unified principals.** All trust-graph entities — agents and issuers — live in a single `principals` table with one namespace: `vrl:p:<uuid>`. This is load-bearing: VeriRank (`pkg/trust/engine.go`) keys scores by a single string, and an entity that receives trust as a subject must pass it on as an issuer under the same ID for transitive propagation to work. Disjoint namespaces would collapse the algorithm to one hop.

`attestations.issuer_id` and `attestations.subject_id` both reference `principals(id)`. A principal can be both an issuer and a subject (e.g., an agent framework that also issues attestations about its sub-agents).

**Principal attributes:**

- `id` — `vrl:p:<uuid>`, the canonical network identifier.
- `kind` — `agent | issuer | both`. A flag indicating capability; `issuer` means it can sign attestations (has at least one key with signing capability), `agent` means it can be a subject. `both` is common for agent frameworks.
- `owner_tenant_id` — the tenant that owns this principal (for dashboard access, private-facts authorization). Nullable for bootstrap seeds.
- `assurance_level` — **derived** (not stored as mutable state): `verified_key` if the principal has at least one non-revoked key with proven control, else `unknown`. Stored as a view or computed on read.

**Keys:** one or more public keys per principal, in `principal_keys`, each expressed as a `did:key` verification method and identified by a `key_id` (e.g. `k1`). Supports rotation and history. The JWS `kid` header carries the `key_id` (required for native v1 submissions).

**Lazy subject creation:** a subject can be attested to before it registers a key. The control plane creates the principal with `vrl:p:<uuid>`, no key, `assurance_level = unknown`. A later verified registration attaches a key and upgrades assurance to `verified_key`.

**Observed fingerprints** (JA4 + canonicalized headers + key hash) are aliases, correlated to the stable ID. **Only `verified_key` aliases are stored.** Unsigned requests have no key hash (4.3) and thus no alias correlation — they are passthrough or denied, never `correlated_behavioral`. The `correlated_behavioral` assurance level is removed (it was incoherent). `agent_fingerprints.assurance_level` is always `verified_key`.

**Alias resolution rule:** a fingerprint matches at most one principal (PK is `fingerprint` alone). Multi-match is impossible by schema. A fingerprint that matches a `verified_key` principal resolves to that principal; all others resolve to unknown.

### 4.5 Data flow

**Attestation ingest:**

1. A counterparty signs a JWS attestation (`iss` = `vrl:p:<issuer-uuid>`, `sub` = `vrl:p:<subject-uuid>`, `kid` = key id, `vli.schema_version`, `vli.type`, `vli.facts`, `vli.visibility`, `vli.trust_level_delta`). `trust_delta` is negative only for `negative_incident`, nonnegative for other types.
2. `control-plane POST /v1/attestations/submit` with the signed JWS.
3. The control plane **pre-parses the unverified JWS** for `iss`, `kid`, and `iat`. It resolves candidate keys from `principal_keys` valid at `iat` and not revoked. If `kid` is present, it selects that key directly; otherwise it falls back to trying each candidate key (legacy). Unknown `iss`: reject 4xx and audit.
4. **Synchronous** signature verification via `trust-engine.VerifyAttestation` (caller supplies `{key_id, public_key}` candidates; engine returns the `verified_key_id` it used). **Synchronous** schema validation against the versioned facts schema for `vli.type@vli.schema_version`. **Synchronous** dedup on `token_digest` (sha256 of JWS, NOT NULL UNIQUE). Invalid → deterministic 4xx.
5. On success: the subject principal is lazily created if absent. The attestation is stored transactionally with a `sync_events` row in the **same transaction** (4.7). A `RunVeriRank` job is enqueued (debounced, one run per minute, plus **hourly periodic recompute** so time decay advances).

**Score computation:**

1. The control plane loads the **active, non-superseded** global attestation set, filtered to attestations younger than **ten half-lives (1800 days)** — at which point the contribution is <0.1% and the truncation error is explicitly tested. This caps the per-run gRPC payload.
2. It calls `trust-engine.RunVeriRank` (client-streamed, chunked) with the attestation set, the global principal list (with `trust_weight` and `is_bootstrap`), the **weighted bootstrap roots** (`Root { id, weight }`), and an explicit `evaluation_time`.
3. The engine runs VeriRank (max 4 hops, distance decay `0.8^d`, time decay half-life 180 days). Roots initialize at `100 × weight` (weighted bootstrap; default `weight = 1.0` → 100). Output is keyed by `vrl:p:<uuid>`, with `entity_kind` (`agent | issuer | both`).
4. The control plane writes results to `network_scores` (durable) and `network_score_history` (only on score change). It appends `score.upsert` / `score.delete` events to `sync_events` **in the same transaction** (4.7).

**Edge sync (unified `sync_version`, transactionally safe):**

1. `edge-verifier` boots with a tenant API key over TLS.
2. It fetches a **full snapshot**: `GET /v1/sync/snapshot` returns a versioned, compressed (gzip, or zstd via Accept-Encoding) payload containing the global score table, the alias map (fingerprint → principal ID), the **active principal verification keys** (principal ID + key ID + public key), and this tenant's active policy. The edge replaces its in-memory snapshot **atomically**. The snapshot includes a `high_water_version` from a **repeatable-read** image of the state.
3. Subsequent updates arrive as **SSE events** from a unified `sync_events` log keyed by a monotonic `sync_version`. Event types: `score.upsert`, `score.delete`, `alias.upsert`, `alias.delete`, `key.upsert`, `key.revoke`, `policy.replace`. The edge applies events in order. If its `Last-Event-ID` is pruned: `410 Gone` → fetch a new full snapshot.
4. **Heartbeats are SSE keepalive comments** (`: ping\n\n`), not durable `sync_events` rows. Freshness is "bytes received on an authenticated stream."
5. The SSE stream is **filtered per tenant**: global score/alias/key events go to all edges; `policy.replace` goes only to the owning tenant's edges.
6. The edge persists each snapshot to disk atomically (`snapshot.json.tmp` → `rename`).
7. Postgres is the durable truth; Redis is rebuilt from Postgres after a restart.

**Allow/deny/passthrough decision:**

1. Inbound request hits `edge-verifier` on 8080.
2. The edge checks for a `Signature` header.
   - **Present + valid:** verify per 4.3, derive `key_hash` from the verified raw 32-byte public key, compute the observed fingerprint, resolve to a principal via the alias map (4.4). Look up the network score (`blacklisted`, `score_reason` are explicit fields). Apply threshold policy → `allow`/`deny`.
   - **Absent or invalid:** apply `policy.unsigned_action` → `passthrough` (proxy, `X-Verilink-Status: Unverified`) or `deny` (403, `X-Verilink-Status: Denied`, `X-Verilink-Reason: unsigned`).
3. The decision is written to a bounded local WAL with a per-edge monotonic `wal_seq`, flushed in batches. WAL-full → drop oldest + increment `decisions_dropped_total` (default); or block (enterprise `no_drop_decisions`, opt-in).
4. **An edge offline >24h:** SSE returns `410 Gone` → full snapshot → resume. Pruning ignores heartbeat rows (they aren't in the log).

### 4.6 Trust-engine gRPC contract

Corrected: unified `principal_id`, `Root { id, weight }`, `verified_key_id` return, raw JSON facts, client-streamed input.

```proto
service TrustEngine {
  rpc RunVeriRank(stream RunChunk) returns (ScoreTable);
  rpc VerifyAttestation(VerifyRequest) returns (VerifyResult);
  rpc Fingerprint(FingerprintRequest) returns (Fingerprint);
}

message RunChunk {
  oneof payload {
    RunHeader header = 1;
    Attestation attestation = 2;
    Issuer issuer = 3;
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
}
message Issuer {
  string principal_id = 1;        // vrl:p:<uuid>
  double trust_weight = 2;
  bool is_bootstrap = 3;
}
message Root {
  string id = 1;                   // vrl:p:<uuid> — a bootstrap principal
  double weight = 2;               // 0.0..1.0; root initializes at 100 × weight
}

message ScoreTable {
  repeated ScoreRow rows = 1;
  int64 computed_at_unix = 2;
}
message ScoreRow {
  string principal_id = 1;
  string entity_kind = 2;          // agent | issuer | both
  int32 score = 3;
  bool blacklisted = 4;
  string score_reason = 5;         // verified | propagated | blacklisted | expired
  // "unknown" is not a stored score_reason — unknown principals have no score row.
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
2. **`trust_weight` application:** per-issuer multiplier on contributions.
3. **`blacklisted` + `score_reason` output:** expose the existing blacklist override; `score_reason` enum (`verified | propagated | blacklisted | expired`). `unknown` is not stored (no row).
4. **Weighted roots:** `Root { id, weight }`; initialize at `100 × weight`. Default `weight = 1.0`. Stepwise de-emphasis reduces `weight`.
5. **Max-path algorithm locked:** the engine takes the max trust path (`engine.go:160`), not weighted average as `trust_graph.md` says. v1 documents this divergence; `trust_graph.md` is updated to match. Consensus redesign deferred.
6. **`entity_kind` + principal scoring:** VeriRank scores every principal (roots start at 100×weight; issuers accumulate score as subjects too). Output includes `entity_kind` from the principal record.

### 4.7 Sync event log (transactionally safe)

A single durable, monotonic event log drives edge sync. `sync_version` is **transactionally safe**: state mutation and the `sync_events` row are written in the **same Postgres transaction**, and `sync_version` is allocated by a **locked allocator** (or a transactional outbox with a single dispatcher) so commit order equals version order. A full snapshot reads from a **repeatable-read** transaction and includes the `high_water_version` from that image.

```sql
sync_events (
  sync_version    bigint pk,          -- allocated by the locked allocator, in-commit-order
  event_type      text not null,      -- score.upsert | score.delete | alias.upsert | alias.delete | key.upsert | key.revoke | policy.replace
  principal_id    text,                -- for score/alias/key events
  tenant_id       uuid,                -- for policy.replace
  payload         jsonb not null,
  created_at      timestamptz not null default now()
);
```

**Heartbeats are not in `sync_events`** — they are SSE keepalive comments (`: ping`). Pruning retains 24h of events. An edge offline >24h gets `410 Gone` → full snapshot → resume.

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

**Whimsy** is the first seeded issuer. Its `shared/verilink.js` submits `behavioral` attestations. Compatibility fixes (6.3): `behavioral@0` schema (allowlisted legacy, 6-month sunset), `token_digest` dedup, lazy `vrl:p:` ID creation, default `visibility: participants` and `schema_version: "0"` for missing fields. Whimsy's `remoteFingerprint` proves the issuer loop, not provider-side agent identification.

**Codero** is the second reference customer, proving the provider loop. A VeriLink-guarded listener in front of `POST /memory/observations`. An OpenCode/Codex session signs requests via HTTP Message Signatures. The OpenCode session's private key lives in **the agent's keychain** (not a file or env var) — the OpenCode runtime loads it from the user's OS keychain (macOS Keychain, Linux Secret Service, Windows Credential Manager) and never exposes it to the agent process or VeriLink. Key custody for the reference deployment is specified, not improvised. VeriLink is not placed in front of the entire Codero dashboard API — only the agent-write surface.

---

## 5. Data model

Postgres. **Logical schema** — executable DDL is generated by the Whimsy-style migration runner. The graph is **global**. Isolation is **application-level** in v1. Tenant-scoped cross-references use **composite tenant-safe FKs**.

### 5.1 Global graph tables

```sql
-- Unified principals: agents and issuers share one namespace.
-- VeriRank keys scores by a single string; an entity that receives trust as a
-- subject must pass it on as an issuer under the same ID.
principals (
  id              text pk,                  -- vrl:p:<uuid>
  kind            text not null,            -- agent | issuer | both
  name            text,
  owner_tenant_id uuid references tenants(id),
  metadata        jsonb default '{}',
  first_seen_at   timestamptz not null default now(),
  last_seen_at    timestamptz not null default now(),
  status          text not null default 'active',  -- active | deactivated
  deactivated_at  timestamptz
);
-- assurance_level is DERIVED (not a stored column): verified_key if the
-- principal has at least one non-revoked key with proven control, else unknown.

-- Principal keys (rotation/history)
principal_keys (
  principal_id    text not null references principals(id),
  key_id          text not null,            -- e.g. k1
  public_key_raw  bytea not null,           -- raw 32-byte Ed25519 public key
  public_key_jwk  jsonb not null,           -- did:key verification method form
  key_hash        text not null,            -- sha256(public_key_raw); indexed for lookup
  valid_from      timestamptz not null default now(),
  valid_until     timestamptz,              -- null = current
  revoked_at      timestamptz,
  revocation_reason text,
  primary key (principal_id, key_id)
);

-- Observed fingerprints correlated to canonical principals (aliases).
-- Only verified_key aliases are stored. Unsigned requests have no key hash
-- and thus no alias. PK is fingerprint alone — one fingerprint → one principal.
agent_fingerprints (
  fingerprint     text primary key,
  principal_id    text not null references principals(id),
  first_seen_at   timestamptz not null default now(),
  last_seen_at    timestamptz not null default now()
);
-- assurance_level is always verified_key (only verified aliases are stored).

-- Issuer attributes (a principal that can sign attestations)
issuers (
  principal_id    text pk references principals(id),
  trust_weight    numeric(3,2) default 1.0, -- applied inside VeriRank
  is_bootstrap    boolean default false,    -- derived from bootstrap_issuers by seeder
  verified_at     timestamptz,             -- set after proof of key control + review
  created_at      timestamptz not null default now()
);

-- Attestations: signed behavioral reports (global)
attestations (
  id              uuid pk,
  issuer_id       text not null references principals(id),
  subject_id      text not null references principals(id),  -- can be an issuer (kyb)
  jws_token       text not null,
  token_digest    text not null unique,    -- sha256(jws_token); dedup
  payload         jsonb not null,
  facts           jsonb not null,          -- shareable facts (public or participants)
  visibility      text not null default 'participants',  -- participants | public
  trust_delta     integer not null,        -- negative ONLY for negative_incident (CHECK below)
  attestation_type text not null,
  schema_version  text not null,           -- mandatory for native v1; "0" allowlisted legacy
  jti             text,                   -- advisory
  issued_at       timestamptz not null,
  expires_at      timestamptz,
  superseded_by   uuid references attestations(id),
  sig_verified    boolean not null default true,
  verified_key_id text,                    -- which key verified (from VerifyResult)
  received_at     timestamptz not null default now(),
  CHECK (
    (attestation_type = 'negative_incident' AND trust_delta < 0)
    OR (attestation_type <> 'negative_incident' AND trust_delta >= 0)
  )
);
-- No facts_private column. Visibility is attestation-level.

-- Network scores: materialized VeriRank output (global)
network_scores (
  principal_id    text primary key,        -- vrl:p:<uuid> (agent, issuer, or both)
  entity_kind     text not null,
  score           integer not null,
  blacklisted     boolean not null default false,
  score_reason    text not null,           -- verified | propagated | blacklisted | expired
  computed_at     timestamptz not null default now(),
  sync_version    bigint not null
);
-- No FK to principals — scores exist for all scored principals (they reference
-- principals by ID but the FK is not enforced to allow transient scoring).

-- Score history: one row per principal per score CHANGE
network_score_history (
  principal_id    text not null,
  score           integer not null,
  blacklisted     boolean not null,
  score_reason    text not null,
  computed_at     timestamptz not null,
  sync_version    bigint not null,
  primary key (principal_id, sync_version)
);

-- Sync event log (unified, transactionally safe) — see 4.7
sync_events (
  sync_version    bigint pk,
  event_type      text not null,
  principal_id    text,
  tenant_id       uuid,
  payload         jsonb not null,
  created_at      timestamptz not null default now()
);

-- Bootstrap registry (split for valid FKs)
bootstrap_issuers (
  principal_id    text pk references principals(id),
  name            text not null,
  current_weight  numeric(3,2) not null default 1.0,  -- written through to issuers.trust_weight by seeder/step
  seeded_at       timestamptz not null default now(),
  de_emphasized_at timestamptz,
  de_emphasis_reason text,
  approved_by     uuid references users(id)
);
-- No bootstrap_agents table. Seeded agents (LangChain et al.) are cold-started
-- via bootstrap-issuer attestations; they are not roots. Roots are always
-- issuers. De-emphasizing a seeded agent = superseding/expiring its bootstrap
-- attestations.
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
  unique (tenant_id, id)                   -- composite for tenant-safe FK target
);

-- Policies: per-tenant threshold + actions (overlay on global scores)
policies (
  id                       uuid pk,
  tenant_id                uuid not null references tenants(id),
  name                     text not null,
  threshold                integer not null default 50,
  below_threshold_action   text not null default 'deny',  -- allow | deny
  unsigned_action          text not null default 'passthrough',  -- passthrough | deny
  allow_fingerprints       text[] default '{}',
  deny_fingerprints        text[] default '{}',
  fail_open_expired        boolean not null default false,  -- serve stale rather than 503
  no_drop_decisions        boolean not null default false,   -- enterprise: block when WAL full
  max_snapshot_age_seconds integer not null default 300,    -- 1 min to 1800 (30 min)
  allow_sample_rate        numeric(4,3) not null default 0.01,  -- 0.000..1.000
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
  api_key_id      uuid,                   -- composite FK below
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

-- Decision aggregates: per-minute rollup. Dimension is explicit.
decision_aggregates (
  id              bigserial pk,
  tenant_id       uuid not null references tenants(id),
  edge_node_id    uuid not null,
  bucket_minute   timestamptz not null,
  principal_id    text,                   -- nullable for the "all" rollup (sentinel '')
  fingerprint     text,                   -- nullable for the principal-level rollup
  action          text not null,           -- allow | deny | passthrough
  count           integer not null,
  primary key (tenant_id, edge_node_id, bucket_minute, action, principal_id, fingerprint)
);
-- High-volume table: composite FKs deliberately omitted for write throughput.
-- Tenant isolation is enforced at the authz layer.

-- Decision samples: all denies + tunable % of allows/passthroughs
decision_samples (
  id              bigserial pk,
  tenant_id       uuid not null references tenants(id),
  edge_node_id    uuid not null,
  wal_seq         bigint not null,         -- per-edge monotonic WAL sequence
  fingerprint     text not null,
  principal_id    text,
  score           integer,
  blacklisted     boolean,
  score_reason    text,
  action          text not null,           -- allow | deny | passthrough
  decided_at      timestamptz not null,
  received_at     timestamptz not null default now(),
  unique (edge_node_id, wal_seq)
);
-- Composite FKs deliberately omitted (high-volume); authz-layer isolation.

-- Batch receipt (idempotent delivery for aggregates + samples)
decision_batches (
  id              uuid pk,                 -- batch_id from the edge
  tenant_id       uuid not null references tenants(id),
  edge_node_id    uuid not null,
  first_wal_seq   bigint not null,
  last_wal_seq    bigint not null,
  received_at     timestamptz not null default now()
);
-- The control plane applies aggregate increments + samples in the SAME
-- transaction as the batch_receipt insert. Re-delivery of the same batch_id
-- is a no-op (idempotent).

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

Application-level in v1. `authz/` injects `WHERE tenant_id = $1` on tenant-scoped tables. Global graph tables are cross-tenant by design (scores, principals, attestations). **Tenants are not a *score-visibility* boundary** — all tenants see all network scores. **Participant facts are tenant-restricted**: `attestations.facts` with `visibility = 'participants'` are visible only to the issuer's `owner_tenant_id`, the subject's `owner_tenant_id`, and VeriLink staff. Composite tenant-safe FKs on `edge_nodes.api_key_id`, `sync_cursors.edge_node_id`. `decision_*` tables are high-volume; composite FKs are deliberately omitted for write throughput, and isolation is enforced at the authz layer.

### 5.4 Multi-tenancy model

Row-level isolation, shared schema. Self-hosted = single tenant. Enterprise = own self-hosted deployment. One code path.

### 5.5 Data retention and privacy

- **Retention:** attestations are retained until the later of (a) `expires_at` and (b) the issuing issuer's deactivation date + 1 year. If both are null, retain indefinitely until the issuer is deactivated (then +1 year). After retention, attestations are **deleted** (not tombstoned).
- **Subject deletion:** the principal is **deactivated** (`status = 'deactivated'`, `deactivated_at = now()`), removed from active scoring. `name` and `metadata` are cleared. The cryptographic record is preserved or deleted **per an explicit legal basis** — not relabeled. Combining subjects into a tombstone is avoided (graph integrity).
- **`/v1/privacy/export` and `/v1/privacy/delete`** are workflow initiators, not compliance certifications. **Privacy counsel validates in two stages**: (1) the retention/erasure model is reviewed **before step 6** (schema freeze) — findings may change `facts`, deletion, and retention columns; (2) counsel sign-off **before step 17** (Whimsy migration, first real personal data ingest).
- **`facts` never written to logs.** Redaction at every egress. `visibility = 'participants'` facts visible only to issuer-owner, subject-owner, and staff.
- **One attestation = one visibility.** No field-level mixed visibility. If an issuer needs some facts public and some private, it issues two attestations — but **doubled trust is prevented**: when two attestations describe the same observation, the most restrictive visibility wins for scoring (the control plane dedups on `(issuer_id, subject_id, attestation_type, facts_hash)` and keeps the most restrictive).
- Decision aggregates: 90 days (pro) / 1 year (enterprise). Decision samples: 30 days (pro) / 90 days (enterprise). Audit log: 90 days (pro) / 1 year (enterprise).

---

## 6. Security

| Concern | Measure |
|---|---|
| **Request authentication** | HTTP Message Signatures (RFC 9421) + Content-Digest (RFC 9530). 128-bit nonce, replay cache. `key_hash` = SHA-256 over raw 32-byte Ed25519 public key, derived after verification. Cross-edge replay accepted in v1 (idempotency is the backend's concern; `Idempotency-Key` recommended for non-idempotent endpoints). |
| **Attestation verification** | Ed25519. Control plane pre-parses JWS for `iss`/`kid`/`iat`, resolves candidate keys from `principal_keys` valid at `iat`, supplies `{key_id, public_key}` candidates. `kid` is required for native v1 submissions; candidate-key trial is the legacy fallback. Returns `verified_key_id`. |
| **API key storage** | HMAC-SHA256. No legacy column. Format `vrl_` + 64 lowercase hex. |
| **Tenant isolation** | Application-level. Global graph cross-tenant. Participant facts tenant-restricted. |
| **RBAC scopes** | `attest:write`, `attest:read`, `sync:read`, `policy:admin`, `tenant:admin`, `billing:read`. |
| **Rate limiting** | Per-tenant by plan. Sync exempt. |
| **Edge auth** | Tenant API key over TLS. mTLS deferred. |
| **Customer private keys** | Never enter VeriLink. Only public keys stored. Bootstrap signing key in KMS/HSM. |
| **Audit** | `audit_log` for admin events. Decisions → aggregates + samples. |
| **Replay protection** | Attestations: `iat`/`exp`, dedup on `token_digest`. Requests: nonce cache. |
| **Fail-closed edge** | Unknown fingerprint → score 0, policy default. Stale beyond `max_snapshot_age_seconds` → 503 (or fail-open if `fail_open_expired`). |

### 6.1 Abuse and Sybil resistance

VeriRank propagates trust **only from roots of trust**. Sock-puppet issuers get zero score (unrooted).

- **Issuer verification:** `issuers.verified_at` after proof of key control + review. Unverified → `trust_weight = 0`.
- **Agent ownership proof:** registration requires signing a challenge.
- **Attestation taxonomy + schema:** control plane validates `attestation_type` + versioned facts schema. Unknown → 4xx.
- **`trust_delta` constraints:** negative only for `negative_incident` (CHECK constraint); nonnegative for others.
- **Negative-report moderation:** `negative_incident` from an issuer with score ≥ 80 (`BlacklistIssuerThreshold`) → `blacklisted = true`. Disputes flag for staff, no auto-revoke.
- **Key revocation:** `principal_keys.revoked_at`; `key.revoke` sync event propagates to all edges.
- **Attestation supersession:** `superseded_by` chain; replaces in next VeriRank run.
- **Visibility:** attestation-level `participants | public`. Doubled trust prevented (most restrictive wins).
- **Bootstrap de-emphasis:** stepwise `current_weight` reduction (100% → 50% → 25% → removal), each step requiring a counterfactual removal report (no principal's score drops below its serving tenant's threshold solely due to the step) and staff approval. The seeder/step writes `current_weight` through to `issuers.trust_weight`. **Trigger:** ≥3 independent verified organic issuers, ≥80% organic weighted contribution for 30 days, counterfactual removal report — **manual, not automatic**. Aligned with the admin-view signal (≥10× ratio is a surface metric; the locked trigger is the ≥80%/3-issuer rule).

### 6.2 JA4 and TLS termination

- **Edge terminates TLS:** full JA4.
- **Behind an existing LB/Cloudflare:** JA4 unavailable. Fingerprint collapses to `headers_hash + key_hash + protocol`. `X-Verilink-Fingerprint-Mode: full | degraded`.
- **Identity continuity:** `key_hash` (from the verified signature) is the durable anchor. UA version bumps change `headers_hash` but not reputation (key hash matches).

### 6.3 Whimsy compatibility

1. `behavioral` added to the enum.
2. Dedup on `token_digest` (no `jti` needed).
3. `schema_version`: Whimsy's payload has none → defaults to `"0"`, validated as `behavioral@0` (exactly what Whimsy sends). **Allowlisted legacy exception**: `@0` accepted only from explicitly allowlisted legacy issuer IDs (initially Whimsy's). New issuers cannot adopt `@0`. **6-month sunset**: after the published deadline, `@0` returns 422. Whimsy migrates to `@1` at launch.
4. `visibility`: Whimsy has none → defaults to `participants`.
5. `iss`/`sub`: Whimsy uses `did:key:whimsy-system` and a `remoteFingerprint` hash. Control plane accepts legacy DIDs/strings, creates `vrl:p:<uuid>` lazily, records the original in `metadata.legacy_did`.

### 6.4 Per-type facts schemas

Versioned JSON Schemas in `docs/specs/`, required before ingest. `schema_version` mandatory for native v1; `additionalProperties: false`. Max 8 KB, depth 4.

- `transaction_summary@1`: observation window (start, end), success count, failure count, dispute count.
- `kyb@1`: status, verifier, jurisdiction, verification timestamp, expiry timestamp.
- `security_audit@1`: standard, result, auditor, report digest, audit timestamp.
- `negative_incident@1`: category, severity, occurrence timestamp, evidence digest.
- `behavioral@0`: Whimsy's current shape (`{ action, ... }`, `additionalProperties: true`).

Facts never feed VeriRank — only `trust_delta` does.

---

## 7. Error handling

### 7.1 Edge (`edge-verifier`, Go)

Three distinct states:

| State | Definition | Behavior |
|---|---|---|
| **Unknown fingerprint** | Not in the current snapshot's alias map | Score 0, `score_reason: unknown` (no row), policy `below_threshold_action`. Common case. |
| **Unsigned** | No signature, or invalid signature | `policy.unsigned_action`: `passthrough` (proxy, `X-Verilink-Status: Unverified`) or `deny` (403). Default `passthrough`. |
| **Degraded (stale)** | Time since last authenticated SSE bytes (heartbeat or event) > `max_snapshot_age_seconds` (default 300, tunable 60–1800) | 503, `X-Verilink-Mode: stale` — unless `fail_open_expired = true`, then serve with `X-Verilink-Mode: expired`. |
| **Degraded (unreachable, contact fresh)** | Sync unreachable, last authenticated bytes within `max_snapshot_age_seconds` | Serve snapshot, `X-Verilink-Mode: degraded`. Retry 1s → 30s. |

Freshness is **time since last authenticated bytes on the stream** (heartbeats are `: ping` comments every 30s). The in-memory snapshot is an **immutable map** (atomic swap), not an LRU. A cache miss means "unknown," never "fall back to an older snapshot."

### 7.2 Control plane (`control-plane` TS)

Structured errors. Attestation ingest: signature + schema verified synchronously; storage + `sync_events` row in the same transaction; only score recomputation enqueued. Invalid → deterministic 4xx. `RunVeriRank` failures retry 3x then dead-letter; `network_scores` stays at last-good; dashboard staleness warning after 1h.

**Decision ingestion:** edge writes decisions to a bounded local WAL with per-edge `wal_seq`. Flushes in batches with a `batch_id`. **WAL full → drop oldest + increment `decisions_dropped_total`** (default; alerted at 70/85/95% of `wal_max_bytes`, default 256 MiB). Enterprise `no_drop_decisions` blocks when WAL full (opt-in; `wal_max_bytes` default 8 GiB, sized via `ceil(p99_wal_bytes/s × required_outage_seconds × 1.5)`). **`MAX_SNAPSHOT_AGE` does not bound a telemetry-only outage** — the no-drop formula is independent. The control plane applies aggregate increments + samples in the **same transaction** as the `decision_batches` insert (idempotent on `batch_id`).

**Sampling:** all denies + `allow_sample_rate` × allows/passthroughs (default 0.01).

### 7.3 Trust engine

Stateless gRPC. Idempotent `RunVeriRank` given same inputs + `evaluation_time`. Panics caught at handler boundary.

### 7.4 Failure notifications

Sentry + Prometheus/Alertmanager. `decisions_dropped_total` is an alert. No n8n error-workflow (that pattern is for n8n executions, not Express).

---

## 8. Observability

| Signal | Source | Tool |
|---|---|---|
| Metrics | `edge-verifier` (local decision overhead, excluding upstream; allow/deny/passthrough counters; cache hit rate; WAL depth; `decisions_dropped_total`; SSE bytes age; seconds-to-WAL-full), `control-plane`, `trust-engine` | Prometheus + Grafana |
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
| **Go core (`pkg/*`)** | Existing tests + property-based (decay invariants, monotonicity, unrooted-cluster zero-score, `trust_weight`, `evaluation_time` determinism). **3-hop transitive contract test**: ingest a chain (root → A, A → B, B → C) and assert C scores non-zero — guards against namespace-split regressions. gRPC contract tests for `cmd/trust-engine`. |
| **Go edge** | Integration: signed + unsigned + unknown + passthrough requests, assert status + headers. **`VR-002` is a dedicated-hardware nightly-staging gate**, local decision overhead only. **First implementation step: Go baseline benchmark** (`scripts/benchmark-baseline.sh`). |
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

OCI `ca-toronto-1` (Toronto), co-located with Whimsy/Codero. `VERILINK_MULTI_TENANT=true`. Single region. Postgres daily snapshots + WAL archiving; **quarterly restore drill**; RPO/RTO verified. **Zero-downtime deploys are a hard requirement**: with the default 5-minute `max_snapshot_age_seconds`, every fail-closed customer 503s if the control plane is down >5 min during a deploy. Deploys use rolling restarts with health-gated traffic shifting.

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
- Attestation feed (incoming + outgoing) with `visibility`.
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
| `client/go` | Add HTTP Message Signature signing; update default URL. |
| `client/node` | npm publish as `@verilink/node` with TS types + signing. |
| `client/rust` | Deferred (post-v1). |

---

## 13. v1 scope and sequencing

1. **Go baseline benchmark** (`scripts/benchmark-baseline.sh`) — first gate. Revisit edge decision if it fails.
2. **Privacy counsel review (stage 1)** — review retention/erasure model (Section 5.5) **before** step 6 freezes the schema.
3. **Monorepo restructure + CI** — directory layout, CI for Go + TS, parity harness scaffold (Go-only).
4. **Engine fixes** — `evaluation_time` determinism, `trust_weight`, `blacklisted` + `score_reason` + `entity_kind`, weighted roots (`Root { id, weight }`), max-path documentation. 3-hop contract test.
5. **Trust-engine gRPC** — client-streamed `RunVeriRank`, `VerifyAttestation` with `{key_id, public_key}` candidates returning `verified_key_id`, `Fingerprint`.
6. **Control-plane TS foundation** — adapt Whimsy's `db/`, `middleware/`, `authz/`, `shared/`. Express + healthcheck. **Migrations (schema frozen after this step).**
7. **Data model + domains** — schema in Section 5. `tenant`, `registry`, `graph`, `policy`, `bootstrap`, `billing`, `events`, `sync`.
8. **Request-auth protocol** — HTTP Message Signature verification in the Go edge; `external_base_url` config; nonce replay cache; `/.well-known/verilink`. Signing helpers in Go + Node.
9. **Attestation ingest end-to-end** — pre-parse JWS for `iss`/`kid`/`iat`, candidate keys, synchronous verify, schema validation, dedup on `token_digest`, lazy principal creation, `kid` required (legacy fallback), `sync_events` row in same transaction.
10. **Network score computation** — global VeriRank (chunked), hourly periodic recompute, write to `network_scores` + `network_score_history` (on change), append to `sync_events` (same transaction).
11. **Sync event log + edge sync** — transactionally safe `sync_version`, snapshot (repeatable-read, `high_water_version`, gzip/zstd), SSE stream with `: ping` heartbeats, `410 Gone` on pruned cursor, per-tenant filtering.
12. **Go edge hardening** — HTTP Message Signatures, versioned sync client, atomic in-memory snapshot, bounded local WAL (drop-oldest + counter; enterprise no-drop), atomic disk snapshots, `decisions_dropped_total`.
13. **Dashboard** — fork the kit; provider + agent-builder + admin views; read-only graph summaries; Stripe portal links.
14. **Bootstrap registry + cold-start seed** — curate root-of-truth; seed script; derive `is_bootstrap`; stepwise de-emphasis mechanism.
15. **Deployment artifacts** — Dockerfiles, Helm, systemd unit, static binary releases.
16. **Clients** — publish Node to npm; update Go client with signing.
17. **Whimsy integration migration** — point `shared/verilink.js` at hosted control plane; `behavioral@0` allowlist; lazy `vrl:p:` IDs. **Privacy counsel sign-off (stage 2) required before this step.**
18. **Codero reference deployment** — guard `POST /memory/observations`; OpenCode/Codex session signs requests via OS keychain.
19. **Docs site** — Docusaurus; schema refs, quickstarts, integration guides, self-host guide.
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
- `correlated_behavioral` assurance level (removed — unsigned requests get no score).
- `unsigned_max_score` cap (removed — unsigned gets no score).
- `facts_private` (removed — attestation-level visibility only).
- `behavioral@0` for new issuers (allowlisted legacy only; 6-month sunset).
- Cross-language parity (v1 is Go-only; Rust must match Go golden hashes to graduate).
- Automatic bootstrap de-emphasis (manual, metric-gated).
- In-band algorithm downgrade negotiation (capability discovery is informational; v1 accepts only ed25519).
- Field-level facts visibility.

---

## 15. Open questions for round 4

1. **`behavioral@0` sunset deadline date.** 6 months from launch — what is the launch date? Set a fixed calendar date once launch is scheduled.
2. **No-drop WAL sizing for non-default rates.** The formula is fixed (`ceil(p99_wal_bytes/s × required_outage_seconds × 1.5)`), but the *default* `required_outage_seconds` for enterprise no-drop needs a recommendation. Proposed: 900s (15 min), matching the max `max_snapshot_age_seconds`.
3. **`Idempotency-Key` recommendation strength.** The spec recommends it for non-idempotent provider endpoints but does not mandate it. Should the Codero reference deployment mandate it as a worked example? Proposed: yes.
4. **Doubled-trust dedup key.** `(issuer_id, subject_id, attestation_type, facts_hash)` — is `facts_hash` SHA-256 of the canonical JSON, or a structural hash that ignores key ordering? Proposed: canonical JSON (sorted keys) SHA-256.
5. **`network_scores` FK to `principals`.** Currently unenforced (to allow transient scoring). Should a deferred constraint be added post-v1? Proposed: yes, once the scoring pipeline is stable.

---

## 16. Success criteria for v1

- [ ] A provider can sign up, get an API key, run the Go `edge-verifier`, and receive allow/deny/passthrough decisions on signed and unsigned traffic in under 15 minutes.
- [ ] **Go baseline benchmark** passes: 10k req/s, sub-millisecond p99 local decision overhead, on a pinned nightly-staging runner.
- [ ] An agent builder can register a principal, attach a key, sign requests with HTTP Message Signatures (incl. nonce), receive an attestation, and see a non-zero trust score.
- [ ] **3-hop transitive contract test passes**: root → A → B → C, C scores non-zero (guards the unified namespace).
- [ ] The bootstrap registry is seeded; providers see a non-empty graph on first sync.
- [ ] Whimsy's `behavioral@0` attestations appear in the graph and dedup on `token_digest`; Whimsy is on the `@0` allowlist.
- [ ] Codero's `POST /memory/observations` is guarded: a signed OpenCode/Codex session is allowed; unsigned is denied (per Codero policy). The session's private key lives in the OS keychain.
- [ ] Self-hosted `docker-compose.self-host.yml` works with no manual SQL.
- [ ] The Node client is published to npm with signing support.
- [ ] `audit_log` records admin events; `decision_aggregates` + `decision_samples` record edge decisions via the bounded local WAL with idempotent batch delivery (`batch_id`). **Dropped decisions are counted via `decisions_dropped_total` and alerted on — no silent loss.** Enterprise no-drop blocks when WAL full (opt-in).
- [ ] All three services have healthchecks wired to K8s probes.
- [ ] Postgres restore drill passes; RPO/RTO verified.
- [ ] `blacklisted` and `score_reason` are surfaced on the dashboard and in edge response headers, not inferred from `score == 0`.
- [ ] The unified sync event log propagates score, alias, key-upsert, key-revoke, and policy changes to connected edges via SSE within one minute. Heartbeats are `: ping` keepalives, not durable rows.
- [ ] Privacy counsel has signed off (stage 2) before the Whimsy migration ingests real personal data.
- [ ] `trust_delta` CHECK constraint rejects positive `negative_incident` deltas and negative other-type deltas.