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

# --check mode: generate into a temp dir and diff against committed outputs
# WITHOUT modifying them. Dispatch BEFORE normal generation.
if [ "${1:-}" = "--check" ]; then
  TMPDIR="$(mktemp -d)"
  trap 'rm -rf "$TMPDIR"' EXIT

  protoc \
    --proto_path="$PROTO_DIR" \
    --go_out="$TMPDIR" \
    --go_opt=paths=source_relative \
    --go-grpc_out="$TMPDIR" \
    --go-grpc_opt=paths=source_relative \
    "$PROTO_DIR/trust.proto"

  for f in trust.pb.go trust_grpc.pb.go; do
    if ! diff -q "$TMPDIR/$f" "$OUT_DIR/$f" >/dev/null 2>&1; then
      echo "FAIL: $OUT_DIR/$f is stale. Run ./scripts/gen-proto.sh and commit."
      exit 1
    fi
  done
  echo "OK: generated code is fresh."
  exit 0
fi

# Normal generation: write to the committed output directory.
mkdir -p "$OUT_DIR"

protoc \
  --proto_path="$PROTO_DIR" \
  --go_out="$OUT_DIR" \
  --go_opt=paths=source_relative \
  --go-grpc_out="$OUT_DIR" \
  --go-grpc_opt=paths=source_relative \
  "$PROTO_DIR/trust.proto"

echo "Generated: $OUT_DIR/trust.pb.go $OUT_DIR/trust_grpc.pb.go"
