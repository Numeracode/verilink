#!/usr/bin/env bash
# Plan 11: build static binary releases for edge-verifier and trust-engine.
# Produces amd64 + arm64 binaries with SHA256 checksums and a CycloneDX SBOM.
#
# Usage: scripts/build-release.sh [version]
#   version defaults to git describe --tags or "dev"
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DIST_DIR="$REPO_ROOT/dist"

VERSION="${1:-$(cd "$REPO_ROOT" && git describe --tags 2>/dev/null || echo dev)}"
ARCHS="amd64 arm64"
BINS="edge-verifier trust-engine"

cd "$REPO_ROOT"
rm -rf "$DIST_DIR"
mkdir -p "$DIST_DIR"

CHECKSUMS_FILE="$DIST_DIR/checksums-sha256.txt"
: > "$CHECKSUMS_FILE"

for arch in $ARCHS; do
  for bin in $BINS; do
    echo "Building $bin for linux/$arch..."
    GOOS=linux GOARCH=$arch CGO_ENABLED=0 go build \
      -ldflags="-s -w -X main.version=$VERSION" \
      -o "$DIST_DIR/verilink-$bin-$VERSION-linux-$arch" \
      "./cmd/$bin"

    sha256sum "$DIST_DIR/verilink-$bin-$VERSION-linux-$arch" >> "$CHECKSUMS_FILE"
  done
done

echo "Generating CycloneDX SBOM..."
syft dir:"$REPO_ROOT" -o cyclonedx-json > "$DIST_DIR/sbom.cdx.json" 2>/dev/null || {
  echo "WARNING: syft not installed; skipping SBOM"
  echo '{"bomFormat":"CycloneDX","specVersion":"1.5","version":1}' > "$DIST_DIR/sbom.cdx.json"
}

echo ""
echo "Release artifacts in $DIST_DIR:"
ls -lh "$DIST_DIR"

echo ""
echo "Checksums:"
cat "$CHECKSUMS_FILE"
