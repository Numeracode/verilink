#!/usr/bin/env bash
# Plan 10 PR B: bring up the full VeriLink dev stack.
#
# Usage:
#   scripts/dev-up.sh          # build + up
#   scripts/dev-up.sh --no-build  # skip rebuild
#
# Requires: docker compose v2, .env.dev-keys (see .gitignore)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

COMPOSE_FILE="$REPO_ROOT/docker-compose.dev.yml"
DEV_KEYS="$REPO_ROOT/.env.dev-keys"

if [ ! -f "$DEV_KEYS" ]; then
  echo "ERROR: .env.dev-keys not found. Generate with:"
  echo "  node -e \"const c=require('crypto');const{publicKey,privateKey}=c.generateKeyPairSync('ed25519');"
  echo "  const p=publicKey.export({format:'jwk'});const s=privateKey.export({format:'jwk'});"
  echo "  console.log('BOOTSTRAP_SEED_PRIVATE_KEY_JWK='+JSON.stringify(s))\" > .env.dev-keys"
  echo "Then update publicKeyX in seedManifest.ts to match the generated public key 'x' value."
  exit 1
fi

cd "$REPO_ROOT"

BUILD_FLAG=""
if [ "${1:-}" = "--no-build" ]; then
  BUILD_FLAG="--no-build"
fi

docker compose -f "$COMPOSE_FILE" up --build $BUILD_FLAG -d

echo ""
echo "VeriLink dev stack starting:"
echo "  Control Plane:  http://localhost:3000"
echo "  Trust Engine:   localhost:9091 (gRPC)"
echo "  Edge Verifier:  http://localhost:8080"
echo "  Postgres:       localhost:15432"
echo "  Redis:          localhost:6379"
echo ""
echo "Logs:  docker compose -f $COMPOSE_FILE logs -f"
echo "Stop:  docker compose -f $COMPOSE_FILE down"
