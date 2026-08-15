#!/usr/bin/env bash
# VeriLink production rebuild — single canonical entry point.
#
# Usage:
#   bash scripts/rebuild-prod.sh                    # rebuild everything
#   bash scripts/rebuild-prod.sh control-plane       # rebuild a single service
#   bash scripts/rebuild-prod.sh --no-build control-plane  # restart without rebuild
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="${REPO_ROOT}/infra/docker-compose.prod.yml"
ENV_FILE="/opt/docker/apps/verilink/.env"
PROJECT_DIR="/opt/docker/apps/verilink"
HEALTH_URL_LOCAL="http://127.0.0.1:8200/healthz"
HEALTH_TIMEOUT_SEC=120

REQUIRED_SECRETS=(
  DB_PASSWORD
  API_KEY_HMAC_SECRET
  EDGE_API_KEY
)

# Pre-flight checks
for secret in "${REQUIRED_SECRETS[@]}"; do
  if ! grep -q "^${secret}=" "$ENV_FILE" 2>/dev/null; then
    echo "ERROR: $secret not set in $ENV_FILE"
    exit 1
  fi
done

if [ ! -f "$COMPOSE_FILE" ]; then
  echo "ERROR: compose file not found at $COMPOSE_FILE"
  exit 1
fi

cd "$PROJECT_DIR"

BUILD_FLAG="--build"
if [ "${1:-}" = "--no-build" ]; then
  BUILD_FLAG="--no-build"
  shift
fi

SERVICES="${*:-}"

echo "Building and starting VeriLink services..."
docker compose -f "$COMPOSE_FILE" --env-file /opt/docker/apps/verilink/.env up $BUILD_FLAG -d $SERVICES

echo ""
echo "Waiting for control-plane health..."
deadline=$((SECONDS + HEALTH_TIMEOUT_SEC))
while [ $SECONDS -lt $deadline ]; do
  if curl -sf "$HEALTH_URL_LOCAL" > /dev/null 2>&1; then
    echo "  Health check passed!"
    echo ""
    echo "VeriLink services running:"
    echo "  Control Plane:  http://127.0.0.1:8200"
    echo "  Trust Engine:   127.0.0.1:9091 (gRPC)"
    echo "  Edge Verifier:  http://127.0.0.1:8085"
    echo "  Postgres:       127.0.0.1:5434"
    echo "  Redis:          127.0.0.1:6381"
    exit 0
  fi
  sleep 2
done

echo "ERROR: health check did not pass within ${HEALTH_TIMEOUT_SEC}s"
docker compose -f "$COMPOSE_FILE" logs control-plane --tail 20
exit 3
