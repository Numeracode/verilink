# Plan 10 — Bootstrap registry + cold-start seed

**Depends on:** Plans 1–9 (merged to `main`, including Plan 9 PR D #29 and its admin bootstrap edit routes)

**Target branch:** `feat/bootstrap-cold-start` (split PRs below)

**Goal:** Make the trust graph non-empty from day one by seeding a curated root-of-truth bootstrap registry, deriving `issuers.is_bootstrap`, writing `current_weight` through to root weight, emitting seeded initial attestations, and wiring the metric-gated manual de-emphasis mechanism.

**Maps to:** productization design §13 step 14 (+ §2.3 cold-start wedge, §5.1 `bootstrap_issuers`, §6.1 de-emphasis).

**Out of scope (design §14):** automatic bootstrap de-emphasis, per-tenant issuer weighting, interactive path explorer.

---

## Context

Plan 9 PR D (#29) already built the read/edit surface; the actual cold-start **seed** is still missing.

| Exists | Missing |
|--------|---------|
| `bootstrap_issuers` table (migration `003`) with `current_weight`, `de_emphasized_at`, `de_emphasis_reason`, `approved_by` | **Seed script** populating `bootstrap_issuers` (no `INSERT ... bootstrap_issuers` outside `testutil/`) |
| `issuers.is_bootstrap` column (migration `001`) — "derived from `bootstrap_issuers` by the seeder" | **Derivation** of `issuers.is_bootstrap` from `bootstrap_issuers` (no `UPDATE issuers SET is_bootstrap`) |
| `GET/PATCH /v1/admin/bootstrap-issuers` + `bootstrapRepository` (list/update/unverified) | **Seeded initial attestations** so providers see a non-empty graph on first sync (success criteria §16: "providers see a non-empty graph on first sync") |
| Graph loader reads roots from `bootstrap_issuers` → `GraphRoot{ weight: current_weight }` (`attestationGraphLoader.ts`); `runVeriRankClient` maps to root `weight` (root initializes at `100 × weight`) | **Curated root-of-truth** data (known agent frameworks w/ published keys, public API providers, VeriLink bootstrap issuer; Whimsy first seeded issuer) |
| `current_weight` `CHECK (0..1)` (migrations `010`/`012`); `Root.weight` is the **only** de-emphasis path; `issuers.trust_weight` stays 1.0 | **`current_weight` write-through** guarantee to the root path used by the graph loader |
| Dashboard `BootstrapEditor` view (weight + de-emphasis reason edit) | **De-emphasis trigger + counterfactual removal report** (§6.1: ≥3 independent verified organic issuers, ≥80% organic weighted contribution for 30 days, report that no principal drops below its serving tenant threshold, staff approval) |
| `scripts/test.sh`, `benchmark-baseline.sh`, `gen-proto.sh` | **`scripts/dev-up.sh`** (design §13 references it: "Docker Compose all services + Postgres + Redis, seed bootstrap registry") |

---

## Locked decisions

1. **Seed idempotency with stable identities:** every seeded row has a **deterministic, immutable identifier**: principals `vrl:p:<fixed-uuid>`, one key per principal with `key_id="bootstrap-k1"` and a fixed `key_hash`, and attestations with a fixed `token_digest` / `facts_hash`. Upserts use these stable conflict keys (`principal_keys.key_hash_unique` already enforces one active key per hash; `attestations.token_digest` is `UNIQUE`). Reruns cannot create duplicates. Seed writes for a single issuer (principal → issuer → key → registry row → attestations) happen in **one transaction** so a partial seed never leaves a half-created root.

2. **Seed preserves mutable registry state across reruns:** the fixed manifest is **insert-only** for the registry's mutable columns — `current_weight`, `de_emphasized_at`, `de_emphasis_reason`, `approved_by`, and explicit removal state are never overwritten by a rerun. A PATCH-removed issuer is **not reinstated** by the manifest (tracked via `de_emphasized_at` + an explicit `removed_from_registry_at`), so staff de-emphasis survives subsequent seeds. Registry updates and the derived `is_bootstrap` flag are applied atomically per issuer.

3. **`is_bootstrap` derivation:** `issuers.is_bootstrap` is set `TRUE` exactly for `principal_id` present in `bootstrap_issuers` **and not removed from the registry** (design §5.1: "derived from bootstrap_issuers by the seeder"). The seeder runs the derivation after upserting the registry; staff removal from the registry (PATCH) clears the flag. No other code path sets it.

4. **Root weight source of truth:** the graph loader already uses `bootstrap_issuers.current_weight` as root weight. The seeder therefore writes `current_weight` directly (default `1.0`); there is **no separate `roots` table**. `issuers.trust_weight` is never touched by de-emphasis — it stays `1.0` for bootstrap issuers (the orthogonal issuer-quality knob, design §6.1). A constraint/test asserts `current_weight` is read as root weight.

5. **Curated seed content (v1):** seed a small fixed set — VeriLink's own bootstrap issuer, Whimsy (first seeded issuer, `behavioral@0` allowlisted legacy), and 2–3 known agent frameworks / public API providers with published public keys. Each is created as: `principals` (`entity_kind='issuer'` or `'both'`) + `issuers` + one `principal_keys` row with `control_verified_at` set. Seed attestations are **only** from VeriLink's bootstrap issuer to seeded agent subjects (a root attests its known agents), giving a non-empty graph without fabricating organic history. No `bootstrap_agents` table — seeded agents are cold-started via bootstrap-issuer attestations (design §5.1 comment).

6. **Seeded attestations are cryptographically real:** seeded attestations carry an **actual JWS signature over the RFC 8785 JCS payload** from the seeded issuer's private key and must pass the normal synchronous verifier (the `attestation` ingest path), not merely set `sig_verified` / `verified_key_id`. Seeded/provenance state is **immutable and explicit**: a stored provenance flag distinguishes bootstrap-origin attestations. **Organic-contribution calculations exclude bootstrap-origin attestations even after the registry row is removed**, so de-emphasis math never double-counts seeded trust.

7. **No fabricated organic trust:** seeded attestations must not masquerade as organic. They are rooted at the VeriLink bootstrap issuer (roots initialize at `100 × weight`) so the graph is visible on first sync, while organic score contribution is counted separately for de-emphasis.

8. **De-emphasis is manual + metric-gated, target-weight aware:** automatic de-emphasis is out of scope (design §14). Plan 10 adds the **signal + report**, not auto-action. A scheduled check (reuse `RecomputeScheduler` cadence) computes bootstrap vs organic weighted contribution over a trailing 30-day window and surfaces the ratio via `GET /v1/admin/bootstrap/de-emphasis` (staff). The trigger is ready only when all conditions hold: **≥3 independent verified organic issuers** (independence defined as distinct `owner_tenant_id` / `entity_kind` provenance, not merely distinct IDs), **≥80% organic weighted contribution continuously for 30 days**, **and** a counterfactual report showing no principal drops below its serving tenant's policy threshold solely due to the step. `computeCounterfactualRemovalReport(rootId, targetWeight)` evaluates the **requested target weight** (e.g. `0.5`, `0.25`, or `0` for removal), not a hard-coded `0`; the approval is **bound to that target weight and the graph version**, and a stale/mismatched report (weight or version changed) is rejected. PATCH remains the only writer of `current_weight`; `de_emphasis_reason` + `approved_by` are required for any step ≤ the current weight.

---

## PR split

### PR A — Seed script + `is_bootstrap` derivation

- `control-plane/scripts/seed-bootstrap.ts` (`npm run seed:bootstrap`) — idempotent, transactional upsert of the curated registry with **deterministic IDs/conflict keys** (decision 1): principals + issuers + keys (`control_verified_at` set) + `bootstrap_issuers` rows (default `current_weight=1.0`). Mutable registry columns are insert-only across reruns (decision 2).
- Derivation: after upsert, `UPDATE issuers SET is_bootstrap = EXISTS(SELECT 1 FROM bootstrap_issuers b WHERE b.principal_id = issuers.principal_id AND b.removed_from_registry_at IS NULL)`; `bootstrapRepository.updateBootstrapIssuer` clears/keeps `is_bootstrap` consistently on PATCH.
- Config: seed path/flag gated so CI and prod do not auto-seed unknown data (`BOOTSTRAP_SEED=1`); `dev-up` seeds by default.
- Tests:
  - Rerun is a no-op; exact seeded IDs/fields asserted (not just counts).
  - Derivation correct; a PATCH-removed issuer has `is_bootstrap=false` and is **not reinstated** by a subsequent seed.
  - **Graph-loader root-weight test:** seed an issuer, PATCH `bootstrap_issuers.current_weight` to `0.5`, reload the graph, and assert `GraphRoot.weight` reflects `0.5` while `issuers.trust_weight` remains `1.0`.
- **Verifies:** success criteria §16 — "The bootstrap registry is seeded; providers see a non-empty graph on first sync."

### PR B — Seeded initial attestations + `scripts/dev-up.sh`

- Seed attestations from the VeriLink bootstrap issuer to seeded agent subjects, each a **real signed JWS over the RFC 8785 JCS facts payload** that passes the normal verifier (decision 6), with an explicit **bootstrap-origin provenance** flag; `token_digest` / `facts_hash` deterministic; `trust_delta >= 0`.
- `scripts/dev-up.sh` — Docker Compose for Postgres + Redis + CP + trust-engine + edge-verifier, runs migrations then `seed:bootstrap` (design §13 line 855).
- Tests:
  - After `dev-up` + a sync, an edge's first snapshot contains non-empty principals/roots/attestations and seeded agents carry a non-zero score.
  - A bootstrap-origin attestation passes signature verification and is excluded from organic-contribution math even after its registry row is removed (decision 6).

### PR C — De-emphasis signal + counterfactual removal report

- `GET /v1/admin/bootstrap/de-emphasis` (staff): bootstrap vs organic weighted contribution over the trailing 30 days, candidate roots for removal, and each candidate's counterfactual report.
- `computeCounterfactualRemovalReport(rootId, targetWeight)`: run the graph recompute with that root at the **requested target weight** (no write), compare per-principal scores against each serving tenant's active `below_threshold_action`/threshold; emit the worst-case drop. Bind the report to `{targetWeight, graphVersion}`; reject stale/mismatched reports. No auto-apply.
- Readiness gate covers **every** trigger condition: the three-issuer minimum, ≥80% organic contribution, the continuous 30-day window, and serving-tenant policy thresholds.
- Trigger surfaced in the dashboard admin `BootstrapEditor` (staff) — read-only ratio + "ready / not ready" for each candidate.
- Tests (boundary fixtures with controlled `issued_at` timestamps and weights):
  - 2 vs 3 independent organic issuers flips readiness (three-issuer minimum).
  - 79% vs 80% organic contribution flips readiness.
  - Contribution window shorter than 30 continuous days → not ready.
  - A root whose removal would drop a principal below its serving-tenant threshold → flagged not-ready.
  - Partial (`0.5`) and full (`0`) removal targets both produce correct reports; a report generated against a stale graph version is rejected.

---

## Out of scope

- Automatic de-emphasis (design §14).
- `bootstrap_agents` table (design §5.1 comment — agents are cold-started via bootstrap-issuer attestations).
- Per-tenant issuer weighting.
- Interactive path explorer / path-summary cards.

---

## Verification

- `npm run seed:bootstrap` twice → identical row sets (`bootstrap_issuers`, `issuers`, `principal_keys`, `attestations`), with **exact IDs and field values** asserted for each seeded row.
- PATCH → seed → reload preserves `current_weight`, `de_emphasized_at`, `de_emphasis_reason`, `approved_by`, and removal state; removed issuers stay removed.
- `issuers.is_bootstrap` true exactly for active `bootstrap_issuers` members; PATCH removal clears it.
- `GET /v1/admin/bootstrap/de-emphasis` returns contribution split + per-candidate counterfactual; ready flags match the ≥3 issuers / ≥80% / 30-day / threshold rules.
- Edge first sync sees a non-empty graph; seeded agents have non-zero score.
- Repository gates: clean workspace, work on `feat/bootstrap-cold-start`, CodeRabbit CLI pre-commit gate, `gitleaks detect --source .`, `go test ./...` and control-plane unit + integration gates (`docs/gate-contract.md`), `@coderabbitai` review before merge.

---

## Acceptance (maps to design §16)

- [ ] The bootstrap registry is seeded; providers see a non-empty graph on first sync.
- [ ] `is_bootstrap` is derived, never hand-maintained outside the seeder, and survives PATCH removal across reruns.
- [ ] Seeded attestations are genuinely signed and pass the normal verifier; bootstrap-origin provenance is immutable and excluded from organic contribution.
- [ ] De-emphasis steps (PATCH `current_weight` / removal) require `de_emphasis_reason` + `approved_by`, are backed by a target-weight + graph-version-bound counterfactual report, and never act automatically.
