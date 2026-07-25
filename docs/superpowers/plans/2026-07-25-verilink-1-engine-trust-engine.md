# VeriLink Engine Fixes + Trust-Engine gRPC Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the VeriRank engine for determinism + trust_weight + weighted roots + explicit blacklist/score_reason output, then expose it (plus attestation verify + fingerprint) behind a gRPC server the TypeScript control plane can call.

**Architecture:** The existing `pkg/trust` and `pkg/attestation` Go packages stay; we add an `evaluation_time` parameter to make VeriRank deterministic, apply per-issuer `trust_weight`, weight bootstrap roots via `Root { id, weight }`, and surface `blacklisted` + `score_reason` in the output. A new `cmd/trust-engine` binary exposes these over gRPC (client-streamed `RunVeriRank` for message-size safety). A 3-hop transitive contract test guards the unified-namespace invariant.

**Tech Stack:** Go 1.22.2, `google.golang.org/grpc@v1.65.0`, `google.golang.org/protobuf@v1.34.2`, `protoc` + `protoc-gen-go@v1.34.2` + `protoc-gen-go-grpc@v1.5.1`. Existing deps: `github.com/golang-jwt/jwt/v5 v5.3.1`.

## Global Constraints

- Go 1.22.2 (per `go.mod`); do not bump the go directive. Pin grpc/protobuf to versions compatible with 1.22 — do NOT use `@latest`.
- Module path: `github.com/messagesgoel-blip/verilink`.
- Branch naming: `feat/<description>` or `fix/<description>`. No direct commits to `main`. PR required before merge.
- CodeRabbit CLI is the pre-commit AI gate (shared rate limit: 12/hr across all repos). Batch the gate: run it once per task (not per commit) to avoid throttling.
- `VR-002` latency benchmark is a dedicated-hardware nightly-staging gate, not a PR gate. The Go baseline benchmark (Task 1) measures local mean decision overhead (not throughput or p99) — the real p99/throughput gate is the nightly k6 run per the spec.
- Max-path is the locked VeriRank conflict-resolution algorithm (not weighted-average). `trust_graph.md` is already updated to match.
- `BlacklistIssuerThreshold = 80` (minimum issuer score to trigger blacklist override) — already in `pkg/trust/engine.go:17`.
- `TimeDecayHalfLifeDays = 180.0`, `DistanceDecay = 0.8`, `MaxHops = 4` — already in `pkg/trust/engine.go:13-15`.
- Canonical principal IDs are `vrl:p:<uuid>` strings. The engine keys scores by a single string (the principal ID); issuer and subject share one namespace.
- The engine is **stateless** from the gRPC server's perspective: all data is supplied per-call. `RunVeriRank` computes from call-local state, not `e.edges`.
- `score_reason` enum: `propagated | blacklisted`. `expired` is NOT an engine value — the control plane handles expiration by deleting the row + emitting `score.delete`. `unknown` is not stored (no row). `verified` is removed (redundant with `propagated`).
- `trust_delta` range: `[-100, 100]`; negative only for `negative_incident`, nonnegative for other types. Enforced by the control plane (CHECK constraints), not the engine — but the engine should not crash on out-of-range input.
- `observation_id` grouping: when non-empty, paired attestations deduplicate to one edge per `(issuer_id, subject_id, observation_id)`; when empty, each attestation is its own group (keyed by `attestation.id`). The **control plane** does this grouping before calling the engine; the engine receives one representative attestation per group and carries `observation_id` for traceability only.
- The existing `verifier.TrustStore` interface is `GetTrustScore(fingerprint string) (verifier.TrustScore, error)` where `TrustScore` is `type TrustScore int`. The existing `NewEdgeVerifierProxy(target string, ts verifier.TrustStore)` already accepts a store — no overload needed.
- The existing `Engine.ReplaceEdgesAndCalculate(claims []*attestation.AttestationClaims) map[string]int` is used by `SyncService` (`pkg/trust/service.go:102`) and must be preserved during the migration.
- The existing `VerilinkClaims` struct is `{ Type string, Facts map[string]interface{}, TrustLevelDelta int }`. It must be extended (backward-compatibly) with `SchemaVersion`, `Visibility`, `ObservationID` so `VerifyAttestation` can return them from the verified payload.

---

## File Structure

| File | Responsibility |
|---|---|
| `pkg/attestation/attestation.go` | Modified: extend `VerilinkClaims` with `SchemaVersion`, `Visibility`, `ObservationID` (backward-compatible). |
| `pkg/trust/score.go` | NEW: `ScoreRow`, `ScoreTable`, `Root`, `Issuer`, `Principal` types. |
| `pkg/trust/engine.go` | Modified: add `RunVeriRank` (call-local, deterministic), fix legacy delegation, sort output rows, preserve `ReplaceEdgesAndCalculate`. |
| `pkg/trust/engine_test.go` | Modified: update for new signatures. |
| `pkg/trust/contract_test.go` | NEW: 3-hop transitive contract test. |
| `pkg/trust/property_test.go` | NEW: property-based tests (testing/quick) for decay, monotonicity, unrooted, permutation invariance, trust weights, determinism, hop bounds. |
| `proto/verilink/trust/v1/trust.proto` | NEW: gRPC service + messages. |
| `pkg/trustpb/trust.pb.go` | NEW: generated protobuf code (committed). |
| `pkg/trustpb/trust_grpc.pb.go` | NEW: generated gRPC code (committed). |
| `cmd/trust-engine/main.go` | NEW: gRPC server binary with health + graceful shutdown + panic recovery. |
| `cmd/trust-engine/server.go` | NEW: gRPC server implementation. |
| `cmd/trust-engine/server_test.go` | NEW: gRPC contract tests. |
| `cmd/trust-engine/health_test.go` | NEW: health check test. |
| `scripts/benchmark-baseline.sh` | NEW: Go edge baseline benchmark (local mean, not p99). |
| `scripts/gen-proto.sh` | NEW: proto codegen command. |
| `go.mod` / `go.sum` | Modified: add pinned grpc + protobuf deps. |

---

## Task 1: Go baseline benchmark (first implementation gate)

**Why first:** The spec says the Go edge-verifier already meets `VR-002` (10k req/s, <1ms p99) per the ROADMAP, but no benchmark artifact exists in the repo. This task produces one measuring **local mean decision overhead** (fingerprint + cache lookup + allow/deny), not throughput or p99 — the real p99/throughput gate is the nightly k6 run on a pinned runner per the spec.

**Files:**
- Create: `scripts/benchmark-baseline.sh`
- Create: `cmd/edge-verifier/benchmark_test.go`

**Interfaces:**
- Consumes: `verifier.NewMockTrustStore()`, `verifier.MockTrustStore.SetTrustScore(fingerprint, score)`, `fingerprint.Generate(RequestData)`, `NewEdgeVerifierProxy(target, ts)` — all existing.
- Produces: a `bench` target runnable via `go test -bench` and a shell script that prints the result.

- [ ] **Step 1: Write the benchmark test**

Create `cmd/edge-verifier/benchmark_test.go`. The benchmark uses the existing `NewEdgeVerifierProxy` (which already accepts a `verifier.TrustStore`), seeds the **computed** fingerprint (not a guessed string), and uses an in-memory `httptest.NewServer` backend so the measurement includes the local decision overhead. The backend is a no-op handler so upstream time is ~0. `httptest.NewServer` does include loopback transport latency, so the reported ns/op is an upper bound on local decision overhead, not a pure measurement — the comment says so.

```go
package main

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/messagesgoel-blip/verilink/pkg/fingerprint"
	"github.com/messagesgoel-blip/verilink/pkg/verifier"
)

// BenchmarkEdgeVerifierDecision measures local decision overhead (fingerprint
// generation + cache lookup + allow/deny) for a single pre-seeded trusted
// request. The backend is an in-memory httptest server (no-op handler), so
// upstream work is ~0; however, httptest includes loopback transport latency,
// so the reported ns/op is an UPPER BOUND on local decision overhead, not a
// pure measurement. The real VR-002 p99/throughput gate is the nightly k6 run
// on a pinned runner per the spec.
func BenchmarkEdgeVerifierDecision(b *testing.B) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(200)
	}))
	defer backend.Close()

	// Seed the trust store with the COMPUTED fingerprint for the request
	// we'll send (matching the demo in main.go).
	trustedData := fingerprint.RequestData{
		JA4:      "test-ja4",
		Protocol: "HTTP/1.1",
		Headers:  map[string]string{"User-Agent": "TestAgent"},
	}
	trustedFP, err := fingerprint.Generate(trustedData)
	if err != nil {
		b.Fatal(err)
	}

	ts := verifier.NewMockTrustStore()
	if err := ts.SetTrustScore(trustedFP, 100); err != nil {
		b.Fatal(err)
	}

	proxy, err := NewEdgeVerifierProxy(backend.URL, ts)
	if err != nil {
		b.Fatal(err)
	}

	req := httptest.NewRequest("GET", "/v1/resource", nil)
	req.Header.Set("X-JA4-Fingerprint", "test-ja4")
	req.Header.Set("User-Agent", "TestAgent")

	b.ResetTimer()
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		w := httptest.NewRecorder()
		proxy.ServeHTTP(w, req)
		if w.Code != 200 {
			b.Fatalf("expected 200 (allowed), got %d — fingerprint may not match the seeded trust store entry", w.Code)
		}
	}
}
```

- [ ] **Step 2: Run the benchmark**

Run: `go test -bench=BenchmarkEdgeVerifierDecision -benchtime=10000x -run='^$' ./cmd/edge-verifier/`
Expected: PASS with a per-op time. Record the ns/op. This is the local mean baseline; the p99 gate is the nightly k6 run.

- [ ] **Step 3: Write the benchmark shell script**

Create `scripts/benchmark-baseline.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

# VeriLink VR-002 local baseline benchmark.
# Measures local mean decision overhead (fingerprint + cache lookup + allow/deny)
# for a single pre-seeded trusted request. This is NOT the p99/throughput gate —
# the real VR-002 gate is the nightly k6 run on a pinned runner per the spec.
# This script establishes the Go baseline so we can detect regressions in CI.
#
# The reported ns/op is an upper bound (httptest includes loopback transport).

BENCHTIME="${BENCHTIME:-10000x}"
OUTPUT="$(mktemp)"

echo "Running VR-002 local baseline benchmark (benchtime=$BENCHTIME)..."
go test -bench=BenchmarkEdgeVerifierDecision -benchtime="$BENCHTIME" -run='^$' ./cmd/edge-verifier/ 2>&1 | tee "$OUTPUT"

# Extract ns/op value (field 3 on the benchmark line) and compare in awk
# (float-safe). 1 ms = 1,000,000 ns.
awk '/^BenchmarkEdgeVerifierDecision/ {
  if ($3+0 > 1000000) {
    print "FAIL: mean ns/op (" $3 ") exceeds 1ms budget"
    exit 1
  } else {
    print "PASS: mean ns/op (" $3 ") within 1ms budget"
    exit 0
  }
}' "$OUTPUT"
RESULT=$?
rm -f "$OUTPUT"
exit $RESULT
```

- [ ] **Step 4: Make it executable and run it**

```bash
chmod +x scripts/benchmark-baseline.sh
./scripts/benchmark-baseline.sh
```
Expected: "PASS: mean ns/op (N) within 1ms budget". If it FAILs, stop and flag — the spec says revisit the edge decision if the baseline fails.

- [ ] **Step 5: Commit**

```bash
git add scripts/benchmark-baseline.sh cmd/edge-verifier/benchmark_test.go
git commit -m "feat(edge): add VR-002 local baseline benchmark (first implementation gate)"
```

---

## Task 2: Extend VerilinkClaims + define new output types

**Why:** The gRPC `VerifyAttestation` must return `schema_version`, `visibility`, `observation_id` from the verified payload — those are signed `vli` fields, not JWS header fields. The existing `VerilinkClaims` struct only has `Type`, `Facts`, `TrustLevelDelta`. We extend it backward-compatibly (absent fields unmarshal to zero values, so Whimsy's existing payload still works). We also define the new output types (`ScoreRow`, `ScoreTable`, `Root`, `Issuer`, `Principal`).

**Files:**
- Modify: `pkg/attestation/attestation.go` (extend `VerilinkClaims`)
- Create: `pkg/trust/score.go`
- Create: `pkg/trust/score_test.go`

**Interfaces:**
- Produces: `attestation.VerilinkClaims` (extended), `trust.ScoreRow`, `trust.ScoreTable`, `trust.Root`, `trust.Issuer`, `trust.Principal` — used by Tasks 3–4 and the gRPC server.

- [ ] **Step 1: Extend VerilinkClaims**

In `pkg/attestation/attestation.go`, add the new fields to `VerilinkClaims`. They are optional (no `omitempty` on JSON unmarshal — absent fields unmarshal to zero values, which is backward-compatible with Whimsy's payload that doesn't set them):

```go
// VerilinkClaims represents the behavioural facts in an attestation.
type VerilinkClaims struct {
	Type            string                 `json:"type"`
	Facts           map[string]interface{} `json:"facts"`
	TrustLevelDelta int                    `json:"trust_level_delta"`
	SchemaVersion   string                 `json:"schema_version,omitempty"`
	Visibility      string                 `json:"visibility,omitempty"`
	ObservationID   string                 `json:"observation_id,omitempty"`
}
```

- [ ] **Step 2: Verify existing attestation tests still pass**

Run: `go test ./pkg/attestation/ -v`
Expected: PASS (the new fields are optional; existing tests don't set them and unmarshal to zero values).

- [ ] **Step 3: Write the trust output types**

Create `pkg/trust/score.go`:

```go
package trust

// ScoreReason is the machine-readable reason for a score.
// Valid values: "propagated", "blacklisted".
// "expired" is NOT an engine value — the control plane handles expiration by
// deleting the row + emitting score.delete. "unknown" is not stored (no row).
// "verified" is removed (redundant with "propagated").
type ScoreReason string

const (
	ScoreReasonPropagated  ScoreReason = "propagated"
	ScoreReasonBlacklisted ScoreReason = "blacklisted"
)

// EntityKind classifies a principal in the trust graph.
type EntityKind string

const (
	EntityKindAgent  EntityKind = "agent"
	EntityKindIssuer EntityKind = "issuer"
	EntityKindBoth   EntityKind = "both"
)

// Root is a weighted bootstrap root of trust. The engine initializes a root
// at 100 * weight. Default weight = 1.0 (score 100). Stepwise de-emphasis
// reduces weight; issuers.trust_weight is the orthogonal issuer-quality knob
// and is NOT touched by de-emphasis.
type Root struct {
	ID     string
	Weight float64
}

// Issuer is a principal that can sign attestations, with a trust_weight that
// multiplies its contributions in VeriRank. trust_weight is the orthogonal
// issuer-quality knob; bootstrap de-emphasis uses Root.Weight, not trust_weight.
type Issuer struct {
	DID         string  // the principal ID (vrl:p:<uuid>)
	TrustWeight float64 // 0.0..1.0 multiplier on this issuer's contributions
	IsBootstrap bool
}

// Principal is a trust-graph entity (agent, issuer, or both). The control plane
// streams these to the engine so it can stamp entity_kind on output rows.
type Principal struct {
	ID          string     // vrl:p:<uuid>
	EntityKind  EntityKind // agent | issuer | both
	TrustWeight float64    // 0.0..1.0; default 1.0 if the principal is absent from the stream
	IsBootstrap bool
}

// ScoreRow is one row of VeriRank output, keyed by canonical principal ID.
type ScoreRow struct {
	PrincipalID string
	EntityKind  EntityKind
	Score       int
	Blacklisted bool
	ScoreReason ScoreReason
}

// ScoreTable is the full VeriRank output. Rows are sorted by PrincipalID for
// deterministic serialization.
type ScoreTable struct {
	Rows           []ScoreRow
	ComputedAtUnix int64
}
```

- [ ] **Step 4: Write a basic test for the types**

Create `pkg/trust/score_test.go`:

```go
package trust

import "testing"

func TestScoreReasonConstants(t *testing.T) {
	if ScoreReasonPropagated != "propagated" {
		t.Errorf("expected propagated, got %s", ScoreReasonPropagated)
	}
	if ScoreReasonBlacklisted != "blacklisted" {
		t.Errorf("expected blacklisted, got %s", ScoreReasonBlacklisted)
	}
}

func TestRootWeight(t *testing.T) {
	r := Root{ID: "vrl:p:abc", Weight: 0.5}
	if r.Weight != 0.5 {
		t.Errorf("expected 0.5, got %f", r.Weight)
	}
}
```

- [ ] **Step 5: Run the test**

Run: `go test ./pkg/trust/ -run TestScoreReason -v && go test ./pkg/trust/ -run TestRootWeight -v`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add pkg/attestation/attestation.go pkg/trust/score.go pkg/trust/score_test.go
git commit -m "feat(trust): extend VerilinkClaims + add ScoreRow, ScoreTable, Root, Issuer, Principal types"
```

---

## Task 3: Fix the engine — determinism, trust_weight, weighted roots, blacklisted + score_reason, sorted output

**Why:** The engine currently (a) calls `time.Now()` so it's non-deterministic, (b) has no per-issuer `trust_weight`, (c) initializes all roots at 100 with no weight, (d) returns `map[string]int` with no `blacklisted`/`score_reason`, (e) emits rows from a map without sorting (non-deterministic serialization). The gRPC contract requires all five fixed. `RunVeriRank` computes from **call-local** state (not `e.edges`) so the engine is stateless from the gRPC server's perspective. The legacy `CalculateScores` and `ReplaceEdgesAndCalculate` are preserved for `SyncService`.

**Files:**
- Modify: `pkg/trust/engine.go`
- Modify: `pkg/trust/engine_test.go` (if needed — legacy tests should pass unchanged)
- Create: `pkg/trust/contract_test.go`

**Interfaces:**
- Consumes: `trust.Root`, `trust.Issuer`, `trust.Principal`, `trust.ScoreRow`, `trust.ScoreTable`, `trust.ScoreReason`, `trust.EntityKind` (from Task 2).
- Produces: `Engine.RunVeriRank(claims, principals, roots, evaluationTime) ScoreTable` — the new entry point. Legacy `CalculateScores() map[string]int` and `ReplaceEdgesAndCalculate(claims) map[string]int` are preserved.

- [ ] **Step 1: Write the failing 3-hop contract test first**

Create `pkg/trust/contract_test.go`:

```go
package trust

import (
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/messagesgoel-blip/verilink/pkg/attestation"
)

// TestContract_3HopTransitivePropagation guards the unified-namespace invariant:
// an entity that receives trust as a subject must pass it on as an issuer under
// the same ID. If subjects and issuers were split into disjoint namespaces,
// this test would fail (C would score 0 because B-as-subject and B-as-issuer
// would be different nodes).
func TestContract_3HopTransitivePropagation(t *testing.T) {
	engine := NewEngine()
	root := "vrl:p:root"
	a := "vrl:p:a"
	b := "vrl:p:b"
	c := "vrl:p:c"

	now := time.Now()
	claims := []*attestation.AttestationClaims{
		{
			RegisteredClaims: jwt.RegisteredClaims{
				Issuer: root, Subject: a, IssuedAt: jwt.NewNumericDate(now),
			},
			VerilinkClaims: attestation.VerilinkClaims{TrustLevelDelta: 100},
		},
		{
			RegisteredClaims: jwt.RegisteredClaims{
				Issuer: a, Subject: b, IssuedAt: jwt.NewNumericDate(now),
			},
			VerilinkClaims: attestation.VerilinkClaims{TrustLevelDelta: 100},
		},
		{
			RegisteredClaims: jwt.RegisteredClaims{
				Issuer: b, Subject: c, IssuedAt: jwt.NewNumericDate(now),
			},
			VerilinkClaims: attestation.VerilinkClaims{TrustLevelDelta: 100},
		},
	}
	roots := []Root{{ID: root, Weight: 1.0}}

	table := engine.RunVeriRank(claims, nil, roots, now)

	// C must score non-zero — transitive propagation works across 3 hops
	// because A, B, and C share one namespace.
	cScore := scoreForRow(t, table, c)
	if cScore <= 0 {
		t.Fatalf("3-hop contract FAILED: C scored %d (expected >0). "+
			"Unified namespace invariant broken — issuer/subject tables split?", cScore)
	}
	t.Logf("3-hop OK: c=%d", cScore)
}

func scoreForRow(t *testing.T, table ScoreTable, id string) int {
	t.Helper()
	for _, row := range table.Rows {
		if row.PrincipalID == id {
			return row.Score
		}
	}
	t.Fatalf("principal %s not in table", id)
	return 0
}
```

- [ ] **Step 2: Run it to verify it fails to compile**

Run: `go test ./pkg/trust/ -run TestContract_3Hop -v`
Expected: compile error — `engine.RunVeriRank` undefined. This is the TDD red state.

- [ ] **Step 3: Implement RunVeriRank with call-local state**

Add to `pkg/trust/engine.go`. `RunVeriRank` builds call-local edge and score maps from the supplied claims/principals/roots, runs the propagation using `evaluationTime` (not `time.Now()`), and returns a sorted `ScoreTable`. It does **not** mutate `e.edges` or `e.rootsOfTrust`.

```go
// RunVeriRank computes trust scores deterministically given the supplied
// attestations, principals (with entity_kind + trust_weight), weighted roots,
// and an explicit evaluation_time. The engine holds no state between calls —
// all data is supplied per-call and computation is call-local.
//
// This is the entry point the gRPC server uses. The legacy CalculateScores()
// and ReplaceEdgesAndCalculate() are preserved for SyncService.
func (e *Engine) RunVeriRank(
	claims []*attestation.AttestationClaims,
	principals []Principal,
	roots []Root,
	evaluationTime time.Time,
) ScoreTable {
	// Build call-local state — do NOT touch e.edges or e.rootsOfTrust.
	weightByDID := make(map[string]float64)
	kindByDID := make(map[string]EntityKind)
	for _, p := range principals {
		weightByDID[p.ID] = p.TrustWeight
		kindByDID[p.ID] = p.EntityKind
	}

	rootSet := make(map[string]bool)
	scores := make(map[string]float64)
	for _, r := range roots {
		rootSet[r.ID] = true
		scores[r.ID] = 100.0 * r.Weight
	}

	// Build call-local edges from claims, using evaluationTime for future-dated checks.
	var edges []Edge
	for _, c := range claims {
		if c == nil || c.IssuedAt == nil {
			continue
		}
		if c.IssuedAt.After(evaluationTime.Add(MaxClockSkew)) {
			continue // reject future-dated beyond skew
		}
		timestamp := c.IssuedAt.Time
		if timestamp.After(evaluationTime) {
			timestamp = evaluationTime
		}
		edges = append(edges, Edge{
			Issuer:    c.Issuer,
			Subject:   c.Subject,
			Score:     c.VerilinkClaims.TrustLevelDelta,
			Timestamp: timestamp,
		})
	}

	// Run propagation using previous-hop / next-hop snapshots to avoid
	// edge-order-dependent over-propagation within a single hop.
	blacklistedNodes := make(map[string]bool)
	for hop := 0; hop < MaxHops; hop++ {
		// Precompute blacklist from the CURRENT (previous-hop) scores.
		blacklistedThisHop := make(map[string]bool)
		for _, edge := range edges {
			if edge.Score < 0 {
				if issuerScore, ok := scores[edge.Issuer]; ok && issuerScore >= float64(BlacklistIssuerThreshold) {
					blacklistedThisHop[edge.Subject] = true
				}
			}
		}

		// Compute next-hop scores from the current snapshot.
		nextScores := make(map[string]float64)
		for k, v := range scores {
			nextScores[k] = v
		}
		changed := false
		for _, edge := range edges {
			if blacklistedThisHop[edge.Issuer] {
				continue
			}
			issuerScore, hasIssuerScore := scores[edge.Issuer]
			if !hasIssuerScore {
				continue
			}
			timeDecay := calculateTimeDecayAt(edge.Timestamp, evaluationTime)
			weight := 1.0 // default for principals absent from the stream
			if w, ok := weightByDID[edge.Issuer]; ok {
				weight = w
			}
			contribution := issuerScore * (float64(edge.Score) / 100.0) * DistanceDecay * timeDecay * weight
			if contribution > nextScores[edge.Subject] {
				nextScores[edge.Subject] = contribution
				changed = true
			}
		}

		// Apply blacklist overrides.
		for subject := range blacklistedThisHop {
			if nextScores[subject] != 0 {
				nextScores[subject] = 0
				blacklistedNodes[subject] = true
				changed = true
			}
		}

		scores = nextScores
		if !changed {
			break
		}
	}

	// Build sorted ScoreTable.
	rows := make([]ScoreRow, 0, len(scores))
	for node, score := range scores {
		clamped := score
		if clamped < 0 {
			clamped = 0
		}
		if clamped > 100 {
			clamped = 100
		}
		rounded := int(math.Round(clamped))

		reason := ScoreReasonPropagated
		blacklisted := false
		if blacklistedNodes[node] {
			blacklisted = true
			reason = ScoreReasonBlacklisted
		}

		rows = append(rows, ScoreRow{
			PrincipalID: node,
			EntityKind:  kindByDID[node], // may be empty for principals not in the stream
			Score:       rounded,
			Blacklisted: blacklisted,
			ScoreReason: reason,
		})
	}

	// Sort by PrincipalID for deterministic serialization.
	sort.Slice(rows, func(i, j int) bool {
		return rows[i].PrincipalID < rows[j].PrincipalID
	})

	return ScoreTable{
		Rows:           rows,
		ComputedAtUnix: evaluationTime.Unix(),
	}
}

// calculateTimeDecayAt is the evaluation_time-aware version of calculateTimeDecay.
func calculateTimeDecayAt(t time.Time, evaluationTime time.Time) float64 {
	daysOld := evaluationTime.Sub(t).Hours() / 24.0
	if daysOld < 0 {
		daysOld = 0
	}
	lambda := math.Log(2) / TimeDecayHalfLifeDays
	return math.Exp(-lambda * daysOld)
}
```

Add `"sort"` to the imports at the top of `engine.go`.

- [ ] **Step 4: Preserve legacy CalculateScores and ReplaceEdgesAndCalculate**

The existing `CalculateScores()` and `ReplaceEdgesAndCalculate()` are used by `SyncService` (`pkg/trust/service.go:102`). They must continue to work. Update them to delegate to the new path internally, but keep their `map[string]int` return type.

For `CalculateScores`, update the existing method to delegate to `RunVeriRank` with default weights and `time.Now()`:

```go
// CalculateScores is the legacy entry point. It delegates to RunVeriRank with
// default principals (trust_weight = 1.0) and roots (weight = 1.0), using
// time.Now() as the evaluation time. New callers should use RunVeriRank.
func (e *Engine) CalculateScores() map[string]int {
	e.mu.RLock()
	defer e.mu.RUnlock()
	return e.calculateScoresLocked()
}

// calculateScoresLocked delegates to RunVeriRank with time.Now() and default
// weights derived from the engine's current rootsOfTrust.
func (e *Engine) calculateScoresLocked() map[string]int {
	now := time.Now()
	roots := make([]Root, 0, len(e.rootsOfTrust))
	for did := range e.rootsOfTrust {
		roots = append(roots, Root{ID: did, Weight: 1.0})
	}
	// Build claims from the current edges.
	claims := make([]*attestation.AttestationClaims, 0, len(e.edges))
	for _, edge := range e.edges {
		claims = append(claims, &attestation.AttestationClaims{
			RegisteredClaims: jwt.RegisteredClaims{
				Issuer:   edge.Issuer,
				Subject:  edge.Subject,
				IssuedAt: jwt.NewNumericDate(edge.Timestamp),
			},
			VerilinkClaims: attestation.VerilinkClaims{
				TrustLevelDelta: edge.Score,
			},
		})
	}
	table := e.RunVeriRank(claims, nil, roots, now)
	out := make(map[string]int, len(table.Rows))
	for _, row := range table.Rows {
		out[row.PrincipalID] = row.Score
	}
	return out
}
```

For `ReplaceEdgesAndCalculate`, update it to replace edges and then delegate:

```go
// ReplaceEdgesAndCalculate atomically replaces the entire edge set and returns
// fresh scores. Preserved for SyncService.
func (e *Engine) ReplaceEdgesAndCalculate(claims []*attestation.AttestationClaims) map[string]int {
	e.mu.Lock()
	defer e.mu.Unlock()

	e.edges = e.edges[:0]
	for _, c := range claims {
		e.addAttestationLocked(c)
	}

	// Delegate to the new path.
	now := time.Now()
	roots := make([]Root, 0, len(e.rootsOfTrust))
	for did := range e.rootsOfTrust {
		roots = append(roots, Root{ID: did, Weight: 1.0})
	}
	table := e.RunVeriRank(claims, nil, roots, now)
	out := make(map[string]int, len(table.Rows))
	for _, row := range table.Rows {
		out[row.PrincipalID] = row.Score
	}
	return out
}
```

- [ ] **Step 5: Run the 3-hop contract test**

Run: `go test ./pkg/trust/ -run TestContract_3Hop -v`
Expected: PASS (C scores non-zero).

- [ ] **Step 6: Run existing tests to verify legacy delegation works**

Run: `go test ./pkg/trust/ -v`
Expected: All PASS (existing `TestEngine_CalculateScores`, `TestEngine_NegativeOverride`, `TestEngine_TimeDecay` pass via the legacy delegation; new `TestContract_3HopTransitivePropagation` passes).

- [ ] **Step 7: Commit**

```bash
git add pkg/trust/engine.go pkg/trust/contract_test.go
git commit -m "feat(trust): RunVeriRank (deterministic, call-local, trust_weight, weighted roots, blacklisted+score_reason, sorted output)"
```

---

## Task 4: Property-based tests for VeriRank invariants

**Why:** The spec requires property-based tests for decay invariants, monotonicity under positive attestations, unrooted-cluster zero-score, and evaluation_time determinism. These use `testing/quick` for generated inputs.

**Files:**
- Create: `pkg/trust/property_test.go`

**Interfaces:**
- Consumes: `trust.Engine`, `trust.RunVeriRank`, `trust.Root`, `trust.Principal` (from Tasks 2–3).

- [ ] **Step 1: Write the property tests**

Create `pkg/trust/property_test.go`:

```go
package trust

import (
	"math/rand"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/messagesgoel-blip/verilink/pkg/attestation"
)

func claim(issuer, subject string, delta int, at time.Time) *attestation.AttestationClaims {
	return &attestation.AttestationClaims{
		RegisteredClaims: jwt.RegisteredClaims{
			Issuer: issuer, Subject: subject, IssuedAt: jwt.NewNumericDate(at),
		},
		VerilinkClaims: attestation.VerilinkClaims{TrustLevelDelta: delta},
	}
}

// TestProperty_UnrootedClusterZeroScore: an issuer cluster with no path from
// any root produces NO score rows (unrooted nodes are never initialized).
func TestProperty_UnrootedClusterZeroScore(t *testing.T) {
	engine := NewEngine()
	now := time.Now()
	claims := []*attestation.AttestationClaims{
		claim("vrl:p:a", "vrl:p:b", 100, now),
	}
	table := engine.RunVeriRank(claims, nil, nil, now)
	if len(table.Rows) != 0 {
		t.Errorf("unrooted cluster produced %d rows (expected 0)", len(table.Rows))
		for _, row := range table.Rows {
			t.Errorf("  unexpected row: %s score=%d", row.PrincipalID, row.Score)
		}
	}
}

// TestProperty_MonotonicityUnderPositiveAttestations: adding a positive
// attestation never decreases any principal's score.
func TestProperty_MonotonicityUnderPositiveAttestations(t *testing.T) {
	f := func(seed int64) bool {
		r := rand.New(rand.NewSource(seed))
		now := time.Now()
		root := "vrl:p:root"
		roots := []Root{{ID: root, Weight: 1.0}}

		delta1 := 1 + r.Intn(99) // [1, 99] — positive
		claims1 := []*attestation.AttestationClaims{
			claim(root, "vrl:p:a", delta1, now),
		}
		table1 := NewEngine().RunVeriRank(claims1, nil, roots, now)
		scoreA1 := scoreForRow(t, table1, "vrl:p:a")

		delta2 := 1 + r.Intn(99) // additional positive
		claims2 := []*attestation.AttestationClaims{
			claim(root, "vrl:p:a", delta1, now),
			claim(root, "vrl:p:a", delta2, now),
		}
		table2 := NewEngine().RunVeriRank(claims2, nil, roots, now)
		scoreA2 := scoreForRow(t, table2, "vrl:p:a")

		return scoreA2 >= scoreA1
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 50}); err != nil {
		t.Error(err)
	}
}

// TestProperty_DecayMonotonic: older attestations produce lower scores than
// fresh ones, all else equal.
func TestProperty_DecayMonotonic(t *testing.T) {
	f := func(ageDays int) bool {
		if ageDays < 0 || ageDays > 365 {
			return true // skip out-of-range
		}
		engine := NewEngine()
		root := "vrl:p:root"
		roots := []Root{{ID: root, Weight: 1.0}}
		evalNow := time.Now()

		fresh := claim(root, "vrl:p:fresh", 100, evalNow)
		old := claim(root, "vrl:p:old", 100, evalNow.Add(-time.Duration(ageDays)*24*time.Hour))

		tableFresh := engine.RunVeriRank([]*attestation.AttestationClaims{fresh}, nil, roots, evalNow)
		tableOld := engine.RunVeriRank([]*attestation.AttestationClaims{old}, nil, roots, evalNow)

		sf := scoreForRow(t, tableFresh, "vrl:p:fresh")
		so := scoreForRow(t, tableOld, "vrl:p:old")
		return so <= sf
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 50}); err != nil {
		t.Error(err)
	}
}

// TestProperty_PermutationInvariance: the order of attestations in the input
// does not change the output.
func TestProperty_PermutationInvariance(t *testing.T) {
	f := func(seed int64) bool {
		r := rand.New(rand.NewSource(seed))
		now := time.Now()
		root := "vrl:p:root"
		roots := []Root{{ID: root, Weight: 1.0}}

		claims := []*attestation.AttestationClaims{
			claim(root, "vrl:p:a", 100, now),
			claim("vrl:p:a", "vrl:p:b", 100, now),
			claim("vrl:p:b", "vrl:p:c", 100, now),
		}
		// Shuffle
		r.Shuffle(len(claims), func(i, j int) {
			claims[i], claims[j] = claims[j], claims[i]
		})

		table := NewEngine().RunVeriRank(claims, nil, roots, now)
		// Run again with a different shuffle
		r.Shuffle(len(claims), func(i, j int) {
			claims[i], claims[j] = claims[j], claims[i]
		})
		table2 := NewEngine().RunVeriRank(claims, nil, roots, now)

		if len(table.Rows) != len(table2.Rows) {
			return false
		}
		for i := range table.Rows {
			if table.Rows[i] != table2.Rows[i] {
				return false
			}
		}
		return true
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 50}); err != nil {
		t.Error(err)
	}
}

// TestProperty_TrustWeightReducesContribution: an issuer with trust_weight < 1.0
// contributes less than the same issuer with trust_weight = 1.0.
func TestProperty_TrustWeightReducesContribution(t *testing.T) {
	engine := NewEngine()
	root := "vrl:p:root"
	a := "vrl:p:a"
	target := "vrl:p:target"
	now := time.Now()
	roots := []Root{{ID: root, Weight: 1.0}}

	claims := []*attestation.AttestationClaims{
		claim(root, a, 100, now),
		claim(a, target, 100, now),
	}

	fullWeight := []Principal{{ID: a, TrustWeight: 1.0}}
	halfWeight := []Principal{{ID: a, TrustWeight: 0.5}}

	tableFull := engine.RunVeriRank(claims, fullWeight, roots, now)
	tableHalf := engine.RunVeriRank(claims, halfWeight, roots, now)

	scoreFull := scoreForRow(t, tableFull, target)
	scoreHalf := scoreForRow(t, tableHalf, target)
	if scoreHalf >= scoreFull {
		t.Errorf("trust_weight 0.5 (%d) should be < trust_weight 1.0 (%d)", scoreHalf, scoreFull)
	}
}

// TestProperty_EvaluationTimeDeterminism: same inputs + same evaluation_time
// produce identical output (including row order, since rows are sorted).
func TestProperty_EvaluationTimeDeterminism(t *testing.T) {
	engine := NewEngine()
	root := "vrl:p:root"
	roots := []Root{{ID: root, Weight: 1.0}}
	evalTime := time.Date(2026, 7, 25, 12, 0, 0, 0, time.UTC)
	claims := []*attestation.AttestationClaims{
		claim(root, "vrl:p:a", 100, evalTime),
		claim("vrl:p:a", "vrl:p:b", 100, evalTime),
	}

	t1 := engine.RunVeriRank(claims, nil, roots, evalTime)
	t2 := engine.RunVeriRank(claims, nil, roots, evalTime)
	if len(t1.Rows) != len(t2.Rows) {
		t.Fatalf("row count differs: %d vs %d", len(t1.Rows), len(t2.Rows))
	}
	for i := range t1.Rows {
		if t1.Rows[i] != t2.Rows[i] {
			t.Errorf("row %d differs: %+v vs %+v", i, t1.Rows[i], t2.Rows[i])
		}
	}
}

// TestProperty_HopBounds: a chain longer than MaxHops does not propagate.
func TestProperty_HopBounds(t *testing.T) {
	engine := NewEngine()
	root := "vrl:p:root"
	now := time.Now()
	roots := []Root{{ID: root, Weight: 1.0}}

	// Build a chain: root -> a0 -> a1 -> a2 -> a3 -> a4 -> a5
	// MaxHops = 4, so a5 (6 hops from root) should not be reached.
	claims := []*attestation.AttestationClaims{
		claim(root, "vrl:p:a0", 100, now),
		claim("vrl:p:a0", "vrl:p:a1", 100, now),
		claim("vrl:p:a1", "vrl:p:a2", 100, now),
		claim("vrl:p:a2", "vrl:p:a3", 100, now),
		claim("vrl:p:a3", "vrl:p:a4", 100, now),
		claim("vrl:p:a4", "vrl:p:a5", 100, now),
	}
	table := engine.RunVeriRank(claims, nil, roots, now)

	// a4 (5 hops) may or may not be reached depending on convergence; a5 (6 hops) must not.
	for _, row := range table.Rows {
		if row.PrincipalID == "vrl:p:a5" && row.Score > 0 {
			t.Errorf("a5 (6 hops) scored %d — MaxHops=4 boundary violated", row.Score)
		}
	}
}
```

Add `"testing/quick"` to the imports.

- [ ] **Step 2: Run the property tests**

Run: `go test ./pkg/trust/ -run TestProperty -v`
Expected: All PASS.

- [ ] **Step 3: Commit**

```bash
git add pkg/trust/property_test.go
git commit -m "test(trust): property-based invariants (unrooted, monotonicity, decay, permutation, trust_weight, determinism, hop bounds)"
```

---

## Task 5: Define the gRPC protobuf contract

**Why:** The control plane (TypeScript) calls the trust engine over gRPC. The proto must match the Go types from Tasks 2–3 exactly.

**Files:**
- Create: `proto/verilink/trust/v1/trust.proto`
- Create: `scripts/gen-proto.sh`

**Interfaces:**
- Produces: the `.proto` file that Task 6 generates Go code from.

- [ ] **Step 1: Write the proto file**

Create `proto/verilink/trust/v1/trust.proto`:

```proto
syntax = "proto3";

package verilink.trust.v1;

option go_package = "github.com/messagesgoel-blip/verilink/pkg/trustpb;trustpb";

service TrustEngine {
  rpc RunVeriRank(stream RunChunk) returns (ScoreTable);
  rpc VerifyAttestation(VerifyRequest) returns (VerifyResult);
  rpc Fingerprint(FingerprintRequest) returns (Fingerprint);
}

// RunVeriRank: client-streamed input to stay within gRPC message limits.
// The first chunk MUST be a RunHeader; subsequent chunks are attestations,
// principals, and roots in any order.
message RunChunk {
  oneof payload {
    RunHeader header = 1;
    Attestation attestation = 2;
    Principal principal = 3;
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

// Principal: streamed so the engine can stamp entity_kind on output rows.
// Principals absent from the stream default to trust_weight = 1.0 (pure agents
// never appear as edge issuers thanks to the issuers FK, so this default is safe).
message Principal {
  string id = 1;                   // vrl:p:<uuid>
  string entity_kind = 2;          // agent | issuer | both
  double trust_weight = 3;        // 0.0..1.0; default 1.0 if absent from stream
  bool is_bootstrap = 4;
}

message Root {
  string id = 1;                   // vrl:p:<uuid> — a bootstrap principal (always an issuer)
  double weight = 2;               // 0.0..1.0; root initializes at 100 * weight
}

message ScoreTable {
  repeated ScoreRow rows = 1;
  int64 computed_at_unix = 2;
}

message ScoreRow {
  string principal_id = 1;
  string entity_kind = 2;
  int32 score = 3;
  bool blacklisted = 4;
  string score_reason = 5;         // propagated | blacklisted
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

message Fingerprint {
  string sha256 = 1;
}
```

- [ ] **Step 2: Write the codegen script**

Create `scripts/gen-proto.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

# Generates Go gRPC + protobuf code from proto/verilink/trust/v1/trust.proto.
# Requires: protoc (install via system package manager), protoc-gen-go,
# protoc-gen-go-grpc.
#
# Install plugins (pinned for Go 1.22 compatibility):
#   go install google.golang.org/protobuf/cmd/protoc-gen-go@v1.34.2
#   go install google.golang.org/grpc/cmd/protoc-gen-go-grpc@v1.5.1
#
# Install protoc if missing (Debian/Ubuntu):
#   sudo apt-get install -y protobuf-compiler

PROTO_DIR="proto/verilink/trust/v1"
OUT_DIR="pkg/trustpb"

mkdir -p "$OUT_DIR"

protoc \
  --proto_path="$PROTO_DIR" \
  --go_out="$OUT_DIR" \
  --go_opt=paths=source_relative \
  --go-grpc_out="$OUT_DIR" \
  --go-grpc_opt=paths=source_relative \
  "$PROTO_DIR/trust.proto"

echo "Generated: $OUT_DIR/trust.pb.go $OUT_DIR/trust_grpc.pb.go"
```

- [ ] **Step 3: Make it executable**

```bash
chmod +x scripts/gen-proto.sh
```

- [ ] **Step 4: Commit**

```bash
git add proto/verilink/trust/v1/trust.proto scripts/gen-proto.sh
git commit -m "feat(proto): add trust-engine gRPC contract (v1)"
```

---

## Task 6: Generate Go code + add pinned gRPC deps

**Why:** Run the codegen and add the grpc/protobuf Go dependencies pinned to versions compatible with Go 1.22.2. Do NOT use `@latest` — current grpc-go releases may require a newer Go toolchain.

**Files:**
- Create: `pkg/trustpb/trust.pb.go` (generated)
- Create: `pkg/trustpb/trust_grpc.pb.go` (generated)
- Modify: `go.mod`, `go.sum`

- [ ] **Step 1: Install protoc plugins (pinned)**

```bash
go install google.golang.org/protobuf/cmd/protoc-gen-go@v1.34.2
go install google.golang.org/grpc/cmd/protoc-gen-go-grpc@v1.5.1
```

If `protoc` itself isn't installed, install it via the system package manager. Do NOT use `apt install` unconditionally in a script — check first:

```bash
if ! command -v protoc &>/dev/null; then
  echo "protoc not found. Install via: sudo apt-get install -y protobuf-compiler"
  exit 1
fi
```

- [ ] **Step 2: Run the codegen**

```bash
./scripts/gen-proto.sh
```
Expected: "Generated: pkg/trustpb/trust.pb.go pkg/trustpb/trust_grpc.pb.go"

- [ ] **Step 3: Add pinned Go deps**

```bash
go get google.golang.org/grpc@v1.65.0
go get google.golang.org/protobuf@v1.34.2
go mod tidy
```

- [ ] **Step 4: Verify it compiles**

Run: `go build ./pkg/trustpb/`
Expected: no errors.

- [ ] **Step 5: Add a generated-code freshness check**

Add to `scripts/gen-proto.sh` a `--check` mode that regenerates and diffs:

```bash
# Append to scripts/gen-proto.sh:
if [ "${1:-}" = "--check" ]; then
  cp "$OUT_DIR/trust.pb.go" /tmp/trust.pb.go.bak
  cp "$OUT_DIR/trust_grpc.pb.go" /tmp/trust_grpc.pb.go.bak
  # Regenerate
  protoc --proto_path="$PROTO_DIR" --go_out="$OUT_DIR" --go_opt=paths=source_relative \
    --go-grpc_out="$OUT_DIR" --go-grpc_opt=paths=source_relative "$PROTO_DIR/trust.proto"
  if ! diff -q /tmp/trust.pb.go.bak "$OUT_DIR/trust.pb.go" || \
     ! diff -q /tmp/trust_grpc.pb.go.bak "$OUT_DIR/trust_grpc.pb.go"; then
    echo "FAIL: generated code is stale. Run ./scripts/gen-proto.sh and commit."
    exit 1
  fi
  echo "OK: generated code is fresh."
fi
```

- [ ] **Step 6: Commit**

```bash
git add pkg/trustpb/ go.mod go.sum scripts/gen-proto.sh
git commit -m "feat(trustpb): generate Go gRPC code + add pinned deps (grpc v1.65.0, protobuf v1.34.2)"
```

---

## Task 7: Implement the gRPC server (`cmd/trust-engine`)

**Why:** The control plane calls this. It wraps `pkg/trust`, `pkg/attestation`, `pkg/fingerprint` behind the gRPC interface. The server uses `io.EOF` for stream termination (not `err == nil`), validates the header is first, stamps `entity_kind` from streamed `Principal` rows, and returns all signed `vli` fields from `VerifyAttestation`.

**Files:**
- Create: `cmd/trust-engine/main.go`
- Create: `cmd/trust-engine/server.go`
- Create: `cmd/trust-engine/server_test.go`

**Interfaces:**
- Consumes: `pkg/trust.Engine.RunVeriRank`, `pkg/attestation.Verify`, `pkg/fingerprint.Generate`, `pkg/trustpb` (generated).
- Produces: a `cmd/trust-engine` binary listening on `:9091`.

- [ ] **Step 1: Write the server implementation**

Create `cmd/trust-engine/server.go`:

```go
package main

import (
	"context"
	"crypto/ed25519"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"sort"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/messagesgoel-blip/verilink/pkg/attestation"
	"github.com/messagesgoel-blip/verilink/pkg/fingerprint"
	"github.com/messagesgoel-blip/verilink/pkg/trust"
	trustpb "github.com/messagesgoel-blip/verilink/pkg/trustpb"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

type server struct {
	trustpb.UnimplementedTrustEngineServer
}

// RunVeriRank consumes a client-streamed RunChunk sequence and returns a ScoreTable.
// The first chunk MUST be a RunHeader; subsequent chunks are attestations,
// principals, and roots in any order.
func (s *server) RunVeriRank(stream trustpb.TrustEngine_RunVeriRankServer) error {
	defer func() {
		if r := recover(); r != nil {
			log.Printf("panic in RunVeriRank: %v", r)
		}
	}()

	var (
		evalTime   time.Time
		claims     []*attestation.AttestationClaims
		principals []trust.Principal
		roots      []trust.Root
		headerSeen bool
	)

	for {
		chunk, err := stream.Recv()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return status.Errorf(codes.Internal, "recv chunk: %v", err)
		}

		switch p := chunk.Payload.(type) {
		case *trustpb.RunChunk_Header:
			if headerSeen {
				return status.Error(codes.InvalidArgument, "duplicate RunHeader")
			}
			if p.Header.EvaluationTimeUnix == 0 {
				return status.Error(codes.InvalidArgument, "evaluation_time_unix is required")
			}
			evalTime = time.Unix(p.Header.EvaluationTimeUnix, 0)
			headerSeen = true
		case *trustpb.RunChunk_Attestation:
			if !headerSeen {
				return status.Error(codes.InvalidArgument, "header must be first chunk")
			}
			if p.Attestation.IssuerId == "" || p.Attestation.SubjectId == "" {
				return status.Error(codes.InvalidArgument, "attestation issuer_id and subject_id are required")
			}
			claims = append(claims, protoAttestationToClaims(p.Attestation))
		case *trustpb.RunChunk_Principal:
			if !headerSeen {
				return status.Error(codes.InvalidArgument, "header must be first chunk")
			}
			if p.Principal.Id == "" {
				return status.Error(codes.InvalidArgument, "principal id is required")
			}
			// Validate trust_weight is in [0, 1]
			if p.Principal.TrustWeight < 0 || p.Principal.TrustWeight > 1 {
				return status.Errorf(codes.InvalidArgument, "principal %s trust_weight %f out of range [0,1]", p.Principal.Id, p.Principal.TrustWeight)
			}
			principals = append(principals, trust.Principal{
				ID:          p.Principal.Id,
				EntityKind:  trust.EntityKind(p.Principal.EntityKind),
				TrustWeight: p.Principal.TrustWeight,
				IsBootstrap: p.Principal.IsBootstrap,
			})
		case *trustpb.RunChunk_Root:
			if !headerSeen {
				return status.Error(codes.InvalidArgument, "header must be first chunk")
			}
			if p.Root.Id == "" {
				return status.Error(codes.InvalidArgument, "root id is required")
			}
			if p.Root.Weight < 0 || p.Root.Weight > 1 {
				return status.Errorf(codes.InvalidArgument, "root %s weight %f out of range [0,1]", p.Root.Id, p.Root.Weight)
			}
			roots = append(roots, trust.Root{
				ID:     p.Root.Id,
				Weight: p.Root.Weight,
			})
		default:
			return status.Error(codes.InvalidArgument, "unknown or empty chunk payload")
		}
	}

	if !headerSeen {
		return status.Error(codes.InvalidArgument, "missing RunHeader chunk")
	}

	engine := trust.NewEngine()
	table := engine.RunVeriRank(claims, principals, roots, evalTime)

	pbRows := make([]*trustpb.ScoreRow, 0, len(table.Rows))
	for _, row := range table.Rows {
		pbRows = append(pbRows, &trustpb.ScoreRow{
			PrincipalId: row.PrincipalID,
			EntityKind:  string(row.EntityKind),
			Score:       int32(row.Score),
			Blacklisted: row.Blacklisted,
			ScoreReason: string(row.ScoreReason),
		})
	}

	// Sort by PrincipalID (the engine already sorts, but be defensive).
	sort.Slice(pbRows, func(i, j int) bool {
		return pbRows[i].PrincipalId < pbRows[j].PrincipalId
	})

	return stream.SendAndClose(&trustpb.ScoreTable{
		Rows:           pbRows,
		ComputedAtUnix: table.ComputedAtUnix,
	})
}

func protoAttestationToClaims(a *trustpb.Attestation) *attestation.AttestationClaims {
	issuedAt := time.Unix(a.IssuedAtUnix, 0)
	var expiresAt *jwt.NumericDate
	if a.ExpiresAtUnix > 0 {
		expiresAt = jwt.NewNumericDate(time.Unix(a.ExpiresAtUnix, 0))
	}
	return &attestation.AttestationClaims{
		RegisteredClaims: jwt.RegisteredClaims{
			Issuer:    a.IssuerId,
			Subject:   a.SubjectId,
			IssuedAt:  jwt.NewNumericDate(issuedAt),
			ExpiresAt: expiresAt,
		},
		VerilinkClaims: attestation.VerilinkClaims{
			TrustLevelDelta: int(a.TrustDelta),
		},
	}
}

// VerifyAttestation tries each candidate key against the JWS token.
// Returns the verified_key_id that matched, plus all signed vli fields.
func (s *server) VerifyAttestation(ctx context.Context, req *trustpb.VerifyRequest) (*trustpb.VerifyResult, error) {
	defer func() {
		if r := recover(); r != nil {
			log.Printf("panic in VerifyAttestation: %v", r)
		}
	}()

	if req.JwsToken == "" {
		return &trustpb.VerifyResult{Valid: false, Error: "jws_token is required"}, nil
	}
	if len(req.CandidateKeys) == 0 {
		return &trustpb.VerifyResult{Valid: false, Error: "at least one candidate key is required"}, nil
	}

	for _, cand := range req.CandidateKeys {
		if len(cand.PublicKey) != ed25519.PublicKeySize {
			continue // wrong key size, try next
		}
		pub := ed25519.PublicKey(cand.PublicKey)
		claims, err := attestation.Verify(req.JwsToken, pub)
		if err != nil {
			continue // this key didn't verify, try next
		}

		// Verified — validate required claims.
		if claims.Issuer == "" || claims.Subject == "" || claims.IssuedAt == nil {
			return &trustpb.VerifyResult{
				Valid: false,
				Error: "verified token missing required iss/sub/iat",
			}, nil
		}

		// Marshal facts to raw JSON bytes.
		factsJSON, err := json.Marshal(claims.VerilinkClaims.Facts)
		if err != nil {
			return &trustpb.VerifyResult{
				Valid: false,
				Error: fmt.Sprintf("marshal facts: %v", err),
			}, nil
		}

		var expUnix int64
		if claims.ExpiresAt != nil {
			expUnix = claims.ExpiresAt.Time.Unix()
		}

		// Extract jti from RegisteredClaims.ID (JWT ID).
		jti := ""
		if claims.ID != "" {
			jti = claims.ID
		}

		return &trustpb.VerifyResult{
			Valid:         true,
			VerifiedKeyId: cand.KeyId,
			IssuerId:      claims.Issuer,
			SubjectId:     claims.Subject,
			Payload: &trustpb.AttestationPayload{
				AttestationType:    claims.VerilinkClaims.Type,
				FactsJson:          factsJSON,
				TrustLevelDelta:    int32(claims.VerilinkClaims.TrustLevelDelta),
				IssuedAtUnix:       claims.IssuedAt.Time.Unix(),
				ExpiresAtUnix:      expUnix,
				Jti:                jti,
				SchemaVersion:      claims.VerilinkClaims.SchemaVersion,
				Visibility:         claims.VerilinkClaims.Visibility,
				ObservationId:      claims.VerilinkClaims.ObservationID,
			},
		}, nil
	}

	return &trustpb.VerifyResult{
		Valid: false,
		Error: "no candidate key verified the token",
	}, nil
}

// Fingerprint matches pkg/fingerprint.Generate exactly.
func (s *server) Fingerprint(ctx context.Context, req *trustpb.FingerprintRequest) (*trustpb.Fingerprint, error) {
	defer func() {
		if r := recover(); r != nil {
			log.Printf("panic in Fingerprint: %v", r)
		}
	}()

	fp, err := fingerprint.Generate(fingerprint.RequestData{
		JA4:      req.Ja4,
		Headers:  req.Headers,
		KeyHash:  req.KeyHash,
		Protocol: req.Protocol,
	})
	if err != nil {
		return nil, status.Errorf(codes.Internal, "fingerprint: %v", err)
	}
	return &trustpb.Fingerprint{Sha256: fp}, nil
}
```

- [ ] **Step 2: Write the main binary with health + graceful shutdown + panic recovery**

Create `cmd/trust-engine/main.go`:

```go
package main

import (
	"log"
	"net"
	"os"
	"os/signal"
	"syscall"

	"google.golang.org/grpc"
	"google.golang.org/grpc/health"
	healthpb "google.golang.org/grpc/health/grpc_health_v1"

	trustpb "github.com/messagesgoel-blip/verilink/pkg/trustpb"
)

func main() {
	addr := os.Getenv("TRUST_ENGINE_ADDR")
	if addr == "" {
		addr = ":9091"
	}

	lis, err := net.Listen("tcp", addr)
	if err != nil {
		log.Fatalf("listen: %v", err)
	}

	grpcSrv := grpc.NewServer(
		grpc.UnaryInterceptor(unaryPanicRecovery),
		grpc.StreamInterceptor(streamPanicRecovery),
	)

	// Register the trust engine service.
	trustpb.RegisterTrustEngineServer(grpcSrv, &server{})

	// Register the gRPC health service.
	healthSrv := health.NewServer()
	healthSrv.SetServingStatus("verilink.trust.v1.TrustEngine", healthpb.HealthCheckResponse_SERVING)
	healthpb.RegisterHealthServer(grpcSrv, healthSrv)

	// Graceful shutdown on SIGTERM/SIGINT.
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGTERM, syscall.SIGINT)
	go func() {
		<-sigCh
		log.Printf("trust-engine shutting down...")
		grpcSrv.GracefulStop()
	}()

	log.Printf("trust-engine listening on %s", addr)
	if err := grpcSrv.Serve(lis); err != nil {
		log.Fatalf("serve: %v", err)
	}
}

func unaryPanicRecovery(ctx context.Context, req interface{}, info *grpc.UnaryServerInfo, handler grpc.UnaryHandler) (resp interface{}, err error) {
	defer func() {
		if r := recover(); r != nil {
			log.Printf("panic recovered in %s: %v", info.FullMethod, r)
			err = status.Errorf(codes.Internal, "internal error")
		}
	}()
	return handler(ctx, req)
}

func streamPanicRecovery(srv interface{}, ss grpc.ServerStream, info *grpc.StreamServerInfo, handler grpc.StreamHandler) (err error) {
	defer func() {
		if r := recover(); r != nil {
			log.Printf("panic recovered in %s: %v", info.FullMethod, r)
			err = status.Errorf(codes.Internal, "internal error")
		}
	}()
	return handler(srv, ss)
}
```

- [ ] **Step 3: Write the contract tests**

Create `cmd/trust-engine/server_test.go`:

```go
package main

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"net"
	"testing"
	"time"

	"github.com/messagesgoel-blip/verilink/pkg/attestation"
	trustpb "github.com/messagesgoel-blip/verilink/pkg/trustpb"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	healthpb "google.golang.org/grpc/health/grpc_health_v1"
)

// startTestServer starts a gRPC server on a random port and returns a client
// + the raw connection (for health checks) + a cleanup func.
func startTestServer(t *testing.T) (trustpb.TrustEngineClient, *grpc.ClientConn, func()) {
	t.Helper()
	lis, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	grpcSrv := grpc.NewServer()
	trustpb.RegisterTrustEngineServer(grpcSrv, &server{})

	// Register health service too.
	healthSrv := health.NewServer()
	healthSrv.SetServingStatus("verilink.trust.v1.TrustEngine", healthpb.HealthCheckResponse_SERVING)
	healthpb.RegisterHealthServer(grpcSrv, healthSrv)

	go grpcSrv.Serve(lis)

	conn, err := grpc.NewClient(lis.Addr().String(), grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		t.Fatal(err)
	}
	client := trustpb.NewTrustEngineClient(conn)
	return client, conn, func() {
		conn.Close()
		grpcSrv.GracefulStop()
	}
}

func TestServer_RunVeriRank_3Hop(t *testing.T) {
	client, _, cleanup := startTestServer(t)
	defer cleanup()

	now := time.Now()
	stream, err := client.RunVeriRank(context.Background())
	if err != nil {
		t.Fatal(err)
	}

	// Header first
	if err := stream.Send(&trustpb.RunChunk{
		Payload: &trustpb.RunChunk_Header{
			Header: &trustpb.RunHeader{EvaluationTimeUnix: now.Unix()},
		},
	}); err != nil {
		t.Fatal(err)
	}

	// Root
	if err := stream.Send(&trustpb.RunChunk{
		Payload: &trustpb.RunChunk_Root{
			Root: &trustpb.Root{Id: "vrl:p:root", Weight: 1.0},
		},
	}); err != nil {
		t.Fatal(err)
	}

	// Attestations: root -> A -> B -> C
	atts := []struct{ issuer, subject string }{
		{"vrl:p:root", "vrl:p:a"},
		{"vrl:p:a", "vrl:p:b"},
		{"vrl:p:b", "vrl:p:c"},
	}
	for _, a := range atts {
		if err := stream.Send(&trustpb.RunChunk{
			Payload: &trustpb.RunChunk_Attestation{
				Attestation: &trustpb.Attestation{
					IssuerId:        a.issuer,
					SubjectId:       a.subject,
					TrustDelta:      100,
					IssuedAtUnix:    now.Unix(),
					AttestationType: "transaction_summary",
				},
			},
		}); err != nil {
			t.Fatal(err)
		}
	}

	table, err := stream.CloseAndRecv()
	if err != nil {
		t.Fatal(err)
	}

	// C must score non-zero (3-hop transitive propagation)
	var cScore int32
	for _, row := range table.Rows {
		if row.PrincipalId == "vrl:p:c" {
			cScore = row.Score
		}
	}
	if cScore <= 0 {
		t.Fatalf("3-hop via gRPC FAILED: C scored %d (expected >0)", cScore)
	}
	t.Logf("3-hop gRPC OK: C scored %d", cScore)
}

func TestServer_VerifyAttestation(t *testing.T) {
	client, _, cleanup := startTestServer(t)
	defer cleanup()

	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	issuer := "vrl:p:issuer"
	subject := "vrl:p:subject"
	token, err := attestation.Sign(issuer, subject, attestation.VerilinkClaims{
		Type:            "transaction_summary",
		Facts:           map[string]interface{}{"count": 42},
		TrustLevelDelta: 50,
		SchemaVersion:   "1",
		Visibility:       "participants",
		ObservationID:    "obs-123",
	}, priv)
	if err != nil {
		t.Fatal(err)
	}

	res, err := client.VerifyAttestation(context.Background(), &trustpb.VerifyRequest{
		JwsToken: token,
		CandidateKeys: []*trustpb.KeyCandidate{
			{KeyId: "k1", PublicKey: pub},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !res.Valid {
		t.Fatalf("expected valid, got invalid: %s", res.Error)
	}
	if res.VerifiedKeyId != "k1" {
		t.Errorf("expected verified_key_id k1, got %s", res.VerifiedKeyId)
	}
	if res.IssuerId != issuer {
		t.Errorf("expected issuer %s, got %s", issuer, res.IssuerId)
	}
	if res.Payload.SchemaVersion != "1" {
		t.Errorf("expected schema_version 1, got %s", res.Payload.SchemaVersion)
	}
	if res.Payload.Visibility != "participants" {
		t.Errorf("expected visibility participants, got %s", res.Payload.Visibility)
	}
	if res.Payload.ObservationId != "obs-123" {
		t.Errorf("expected observation_id obs-123, got %s", res.Payload.ObservationId)
	}
}

func TestServer_VerifyAttestation_WrongKeyFirst(t *testing.T) {
	client, _, cleanup := startTestServer(t)
	defer cleanup()

	// Two keypairs: wrong one first, right one second.
	wrongPub, _, _ := ed25519.GenerateKey(rand.Reader)
	rightPub, rightPriv, _ := ed25519.GenerateKey(rand.Reader)

	token, err := attestation.Sign("vrl:p:issuer", "vrl:p:subject", attestation.VerilinkClaims{
		Type:            "transaction_summary",
		TrustLevelDelta: 50,
	}, rightPriv)
	if err != nil {
		t.Fatal(err)
	}

	res, err := client.VerifyAttestation(context.Background(), &trustpb.VerifyRequest{
		JwsToken: token,
		CandidateKeys: []*trustpb.KeyCandidate{
			{KeyId: "wrong", PublicKey: wrongPub},
			{KeyId: "right", PublicKey: rightPub},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !res.Valid {
		t.Fatal("expected valid with second key")
	}
	if res.VerifiedKeyId != "right" {
		t.Errorf("expected verified_key_id right, got %s", res.VerifiedKeyId)
	}
}

func TestServer_VerifyAttestation_MalformedKey(t *testing.T) {
	client, _, cleanup := startTestServer(t)
	defer cleanup()

	res, err := client.VerifyAttestation(context.Background(), &trustpb.VerifyRequest{
		JwsToken: "some.token.here",
		CandidateKeys: []*trustpb.KeyCandidate{
			{KeyId: "k1", PublicKey: []byte("too-short")},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if res.Valid {
		t.Error("expected invalid for malformed key")
	}
}

func TestServer_Fingerprint(t *testing.T) {
	client, _, cleanup := startTestServer(t)
	defer cleanup()

	res, err := client.Fingerprint(context.Background(), &trustpb.FingerprintRequest{
		Ja4:      "test-ja4",
		Headers:  map[string]string{"User-Agent": "TestAgent"},
		Protocol: "HTTP/1.1",
	})
	if err != nil {
		t.Fatal(err)
	}
	if res.Sha256 == "" {
		t.Fatal("expected non-empty fingerprint")
	}
}
```

- [ ] **Step 4: Write the health test**

Create `cmd/trust-engine/health_test.go`:

```go
package main

import (
	"context"
	"testing"

	healthpb "google.golang.org/grpc/health/grpc_health_v1"
)

func TestServer_Health(t *testing.T) {
	_, conn, cleanup := startTestServer(t)
	defer cleanup()

	healthClient := healthpb.NewHealthClient(conn)
	res, err := healthClient.Check(context.Background(), &healthpb.HealthCheckRequest{
		Service: "verilink.trust.v1.TrustEngine",
	})
	if err != nil {
		t.Fatal(err)
	}
	if res.Status != healthpb.HealthCheckResponse_SERVING {
		t.Errorf("expected SERVING, got %s", res.Status)
	}
}
```

- [ ] **Step 5: Run all contract tests**

Run: `go test ./cmd/trust-engine/ -v`
Expected: All PASS (3-hop via gRPC, VerifyAttestation, VerifyAttestation_WrongKeyFirst, VerifyAttestation_MalformedKey, Fingerprint, Health).

- [ ] **Step 6: Commit**

```bash
git add cmd/trust-engine/
git commit -m "feat(trust-engine): gRPC server (RunVeriRank, VerifyAttestation, Fingerprint) with health + panic recovery"
```

---

## Task 8: Final verification + PR

**Why:** Run the full test suite, run the benchmark, open the PR.

- [ ] **Step 1: Run all Go tests**

Run: `go test ./...`
Expected: All PASS.

- [ ] **Step 2: Run the baseline benchmark**

Run: `./scripts/benchmark-baseline.sh`
Expected: PASS (mean ns/op < 1ms).

- [ ] **Step 3: Run go vet**

Run: `go vet ./...`
Expected: no issues.

- [ ] **Step 4: Verify generated code freshness**

Run: `./scripts/gen-proto.sh --check`
Expected: "OK: generated code is fresh."

- [ ] **Step 5: Push the branch + open a PR**

```bash
git push -u origin feat/engine-trust-engine
gh pr create --title "feat: VeriRank engine fixes + trust-engine gRPC server" \
  --body "Implements Plan 1 of the VeriLink productization spec.

- VeriRank: determinism (evaluation_time), trust_weight, weighted roots (Root { id, weight }), blacklisted + score_reason output, sorted rows
- Call-local computation (no mutation of e.edges in RunVeriRank)
- 3-hop transitive contract test (guards unified namespace)
- Property-based tests (testing/quick): unrooted, monotonicity, decay, permutation invariance, trust_weight, determinism, hop bounds
- VerilinkClaims extended with schema_version, visibility, observation_id (backward-compatible)
- gRPC server (cmd/trust-engine) wrapping pkg/trust, attestation, fingerprint
- gRPC health service + graceful shutdown + panic recovery
- VerifyAttestation returns all signed vli fields; wrong-key-first candidate selection tested
- VR-002 local baseline benchmark (mean, not p99 — p99 is the nightly k6 gate)
- Pinned grpc v1.65.0 + protobuf v1.34.2 (Go 1.22 compatible)

Spec: docs/superpowers/specs/2026-07-25-verilink-productization-design.md"
```

- [ ] **Step 6: Request CodeRabbit review (batch once per task, not per commit)**

Comment on the PR: `@coderabbitai review`

- [ ] **Step 7: Address review findings, then merge**

Address any CodeRabbit findings, then merge the PR once approved. Do not squash (the task-by-task commits are useful history).

---

## Self-Review Notes

**Spec coverage (Plan 1 scope — spec steps 1, 4, 5):**
- Step 1 (Go baseline benchmark) → Task 1 ✓
- Step 4 (Engine fixes: determinism, trust_weight, blacklisted+score_reason, weighted roots, max-path documentation, 3-hop contract test) → Tasks 2–4 ✓
- Step 5 (Trust-engine gRPC: client-streamed RunVeriRank, VerifyAttestation with candidate keys returning verified_key_id, Fingerprint) → Tasks 5–7 ✓

**Placeholder scan:** No TBD/TODO/"add error handling" in any step. All code blocks are complete and match the real repo interfaces (`verifier.TrustScore`, `verifier.NewMockTrustStore`, `NewEdgeVerifierProxy(target, ts)`, `VerilinkClaims` struct, `ReplaceEdgesAndCalculate`).

**Type consistency:** `ScoreRow`, `ScoreTable`, `Root`, `Issuer`, `Principal` defined in Task 2, used consistently in Tasks 3–4 and mapped to proto in Task 5. `RunVeriRank(claims, principals, roots, evaluationTime) ScoreTable` signature consistent across Tasks 3–4 and the gRPC server in Task 7. `VerilinkClaims` extended fields (`SchemaVersion`, `Visibility`, `ObservationID`) populated in `VerifyAttestation` (Task 7).

**Round-1 review corrections applied:**
1. ✓ Stream-receive loop uses `errors.Is(err, io.EOF)` (not `err == nil`)
2. ✓ Legacy `CalculateScores` builds scores map from `e.rootsOfTrust` (not empty), no unused locals
3. ✓ Output rows sorted by `PrincipalID` (deterministic serialization)
4. ✓ Benchmark uses existing `NewEdgeVerifierProxy(target, ts)` + `verifier.NewMockTrustStore()` + computed fingerprint; awk reads field 3 (float-safe)
5. ✓ grpc/protobuf pinned to v1.65.0/v1.34.2 (Go 1.22 compatible), no `@latest`
6. ✓ `entity_kind` stamped from streamed `Principal` rows via `kindByDID` map
7. ✓ `VerifyAttestation` returns `schema_version`, `visibility`, `observation_id` from extended `VerilinkClaims`
8. ✓ `testing/quick` for property tests; unrooted test asserts `len(table.Rows) == 0`
9. ✓ `startTestServer` returns `*grpc.ClientConn` for health checks; health service registered
10. ✓ `ReplaceEdgesAndCalculate` preserved for `SyncService`
11. ✓ `RunVeriRank` computes from call-local state (no `e.edges` mutation)
12. ✓ Previous-hop/next-hop snapshots prevent over-propagation within a hop
13. ✓ Panic recovery via interceptors
14. ✓ Generated-code freshness check (`--check` mode)
15. ✓ Default `trust_weight = 1.0` for principals absent from the stream documented in proto comment
16. ✓ CodeRabbit batched once per task, not per commit
17. ✓ Spec residue at line 910 (`expired` in engine enum) fixed

**Not in this plan (covered by subsequent plans):**
- Control-plane TS foundation + data model (spec steps 6–7) → Plan 2
- Request-auth protocol (spec step 8) → Plan 3
- Attestation ingest + score computation (spec steps 9–10) → Plan 4
- Sync event log + edge sync (spec step 11) → Plan 5
- Go edge hardening (spec step 12) → Plan 6
- Dashboard (spec step 13) → Plan 7
- Bootstrap + deploy + clients + integrations + docs (spec steps 14–20) → Plan 8