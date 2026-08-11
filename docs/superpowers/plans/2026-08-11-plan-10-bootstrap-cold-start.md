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

1. **Seed idempotency:** the seed is a re-runnable migration-style script (`npm run seed:bootstrap`) keyed on principal `id`. Re-running must not duplicate issuers, keys, or attestations. Use `INSERT ... ON CONFLICT DO NOTHING` / `DO UPDATE SET` and skip already-seeded rows via `issuers.is_bootstrap`. Seed writes happen inside a single transaction per issuer so a partial seed never leaves a half-created root.
2. **`is_bootstrap` derivation:** `issuers.is_bootstrap` is set `TRUE` exactly for `principal_id` present in `bootstrap_issuers` (design §5.1: "derived from bootstrap_issuers by the seeder"). The seeder runs the derivation after upserting the registry; staff removal from the registry (PATCH) clears the flag. No other code path sets it.
3. **Root weight source of truth:** the graph loader already uses `bootstrap_issuers.current_weight` as root weight. The seeder therefore writes `current_weight` directly (default `1.0`); there is **no separate `roots` table**. `issuers.trust_weight` is never touched by de-emphasis — it stays `1.0` for bootstrap issuers (the orthogonal issuer-quality knob, design §6.1). A constraint/test asserts `current_weight` is read as root weight.
4. **Curated seed content (v1):** seed a small fixed set — VeriLink's own bootstrap issuer, Whimsy (first seeded issuer, `behavioral@0` allowlisted legacy), and 2–3 known agent frameworks / public API providers with published public keys. Each is created as: `principals` (`entity_kind='issuer'` or `'both'`) + `issuers` + one `principal_keys` row with `control_verified_at` set. Seed attestations are **only** from VeriLink's bootstrap issuer to seeded agent subjects (a root attests its known agents), giving a non-empty graph without fabricating organic history. No `bootstrap_agents` table — seeded agents are cold-started via bootstrap-issuer attestations (design §5.1 comment).
5. **No fabricated organic trust:** seeded attestations must not masquerade as organic. They are rooted at the VeriLink bootstrap issuer (roots initialize at `100 × weight`) so the graph is visible on first sync, while organic score contribution is counted separately for de-emphasis.
6. **De-emphasis is manual + metric-gated:** automatic de-emphasis is out of scope (design §14). Plan 10 adds the **signal + report**, not auto-action. A scheduled check (reuse `RecomputeScheduler` cadence) computes bootstrap vs organic weighted contribution over a 30-day window and surfaces the ratio via `GET /v1/admin/bootstrap/de-emphasis` (staff). The trigger fires only when: ≥3 independent verified organic issuers, ≥80% organic weighted contribution for 30 days, **and** a counterfactual removal report (recompute with the candidate root at `weight=0`, assert no principal's score drops below its serving tenant's policy threshold solely due to the step). PATCH remains the only writer of `current_weight`; `de_emphasis_reason` + `approved_by` are required for any step ≤ the current weight.

---

## PR split

### PR A — Seed script + `is_bootstrap` derivation
- `control-plane/scripts/seed-bootstrap.ts` (`npm run seed:bootstrap`) — idempotent, transactional upsert of the curated registry: principals + issuers + keys (`control_verified_at` set) + `bootstrap_issuers` rows (default `current_weight=1.0`).
- Derivation: after upsert, `UPDATE issuers SET is_bootstrap = EXISTS(SELECT 1 FROM bootstrap_issuers b WHERE b.principal_id = issuers.principal_id)`; `bootstrapRepository.updateBootstrapIssuer` clears/keeps `is_bootstrap` consistently on PATCH.
- Config: seed path/flag gated so CI and prod do not auto-seed unknown data (`BOOTSTRAP_SEED=1`); `dev-up` seeds by default.
- Unit + integration tests: re-running is a no-op; derivation correct; `current_weight` read as root weight by the graph loader (`attestationGraphLoader` returns a root for a seeded issuer).
- **Verifies:** success criteria §16 — "The bootstrap registry is seeded; providers see a non-empty graph on first sync."

### PR B — Seeded initial attestations + `scripts/dev-up.sh`
- Seed attestations from the VeriLink bootstrap issuer to seeded agent subjects (`attestations` rows, `sig_verified=true`, `verified_key_id` = the seeded issuer's key; `facts_hash` = SHA-256 RFC 8785 JCS; `trust_delta >= 0`).
- `scripts/dev-up.sh` — Docker Compose for Postgres + Redis + CP + trust-engine + edge-verifier, runs migrations then `seed:bootstrap` (design §13 line 855).
- Integration test: after `dev-up` + a sync, an edge's first snapshot contains non-empty principals/roots/attestations and seeded agents carry a non-zero score.

### PR C — De-emphasis signal + counterfactual removal report
- `GET /v1/admin/bootstrap/de-emphasis` (staff): bootstrap vs organic weighted contribution over the trailing 30 days, candidate roots for removal, and each candidate's counterfactual report.
- `computeCounterfactualRemovalReport(rootId)`: run the graph recompute with that root at `weight=0` (no write), compare per-principal scores against each serving tenant's active `below_threshold_action`/threshold; emit the worst-case drop. No auto-apply.
- Trigger surfaced in the dashboard admin `BootstrapEditor` (staff) — read-only ratio + "ready / not ready" for each candidate.
- Test: with 2 organic issuers (not ready) vs 3 (ready), the report flips; a root whose removal would drop a principal below threshold is flagged not-ready.

---

## Out of scope
- Automatic de-emphasis (design §14).
- `bootstrap_agents` table (design §5.1 comment — agents are cold-started via bootstrap-issuer attestations).
- Per-tenant issuer weighting.
- Interactive path explorer / path-summary cards.

---

## Verification
- `npm run seed:bootstrap` twice → same row counts (`bootstrap_issuers`, `issuers`, `principal_keys`, `attestations`).
- `issuers.is_bootstrap` true exactly for `bootstrap_issuers` members; PATCH removal clears it.
- `GET /v1/admin/bootstrap/de-emphasis` returns contribution split + per-candidate counterfactual; ready flags match the ≥3 issuers / ≥80% rules.
- Edge first sync sees a non-empty graph; seeded agents have non-zero score.
- `go test ./...` and `control-plane` unit + integration gates pass (`docs/gate-contract.md`).

---

## Acceptance (maps to design §16)
- [ ] The bootstrap registry is seeded; providers see a non-empty graph on first sync.
- [ ] `is_bootstrap` is derived, never hand-maintained outside the seeder.
- [ ] De-emphasis steps (PATCH `current_weight` / removal) require `de_emphasis_reason` + `approved_by`, are backed by a counterfactual report, and never act automatically.
