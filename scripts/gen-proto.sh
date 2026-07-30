#!/usr/bin/env bash
set -euo pipefail

# Generates Go gRPC + protobuf code via buf (same path as CI Proto job).
# Requires: buf, go.
#
# Pins match .github/workflows/ci.yml Proto job:
PROTOC_GEN_GO_VER=v1.36.11
PROTOC_GEN_GO_GRPC_VER=v1.6.2

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

go_bin_dir() {
  local gobin
  gobin="$(go env GOBIN)"
  if [ -n "$gobin" ]; then
    printf '%s\n' "$gobin"
  else
    printf '%s\n' "$(go env GOPATH)/bin"
  fi
}

ensure_plugins() {
  go install "google.golang.org/protobuf/cmd/protoc-gen-go@${PROTOC_GEN_GO_VER}"
  go install "google.golang.org/grpc/cmd/protoc-gen-go-grpc@${PROTOC_GEN_GO_GRPC_VER}"
  go install golang.org/x/tools/cmd/goimports@latest
  # Prefer GOBIN (where go install writes) over a stale GOPATH/bin earlier on PATH.
  export PATH="$(go_bin_dir):${PATH}"
}

generate() {
  ensure_plugins
  (cd proto && buf generate --template ../buf.gen.yaml)
  goimports -w pkg/trustpb/trust.pb.go pkg/trustpb/trust_grpc.pb.go
}

# --check mode: regenerate in a temp copy and diff WITHOUT modifying
# committed outputs. Uses the same buf template + pinned plugins as CI.
if [ "${1:-}" = "--check" ]; then
  ensure_plugins
  TMPDIR="$(mktemp -d)"
  trap 'rm -rf "$TMPDIR"' EXIT
  cp -a proto buf.gen.yaml "$TMPDIR/"
  mkdir -p "$TMPDIR/pkg/trustpb"
  cp -a pkg/trustpb/. "$TMPDIR/pkg/trustpb/"
  (
    cd "$TMPDIR"
    export PATH="$(go_bin_dir):${PATH}"
    (cd proto && buf generate --template ../buf.gen.yaml)
    goimports -w pkg/trustpb/trust.pb.go pkg/trustpb/trust_grpc.pb.go
  )
  if ! diff -ru pkg/trustpb "$TMPDIR/pkg/trustpb" >/dev/null; then
    echo "FAIL: pkg/trustpb is stale. Run ./scripts/gen-proto.sh and commit."
    diff -ru pkg/trustpb "$TMPDIR/pkg/trustpb" || true
    exit 1
  fi
  echo "OK: generated code is fresh."
  exit 0
fi

generate
echo "Generated: pkg/trustpb/trust.pb.go pkg/trustpb/trust_grpc.pb.go"
