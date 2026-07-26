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
trap 'rm -f "$OUTPUT"' EXIT

echo "Running VR-002 local baseline benchmark (benchtime=$BENCHTIME)..."
go test -bench=BenchmarkEdgeVerifierDecision -benchtime="$BENCHTIME" -run='^$' ./cmd/edge-verifier/ 2>&1 | tee "$OUTPUT"

# Extract ns/op value and compare in awk (float-safe). 1 ms = 1,000,000 ns.
# The benchmark result line format is:
#   <iterations>  <ns/op_value> ns/op  <bytes> B/op  <allocs> allocs/op
# Match lines containing "ns/op" AND a numeric field 2 (to exclude the
# PASS/FAIL echo lines that also contain "ns/op" in their text).
awk '
/ns\/op/ && $2+0 > 0 {
  if ($2+0 > 1000000) {
    print "FAIL: mean ns/op (" $2 ") exceeds 1ms budget"
    found = 1
    exit 1
  } else {
    print "PASS: mean ns/op (" $2 ") within 1ms budget"
    found = 1
    exit 0
  }
}
END {
  if (!found) {
    print "FAIL: no benchmark result line matched — benchmark may not have run"
    exit 1
  }
}' "$OUTPUT"