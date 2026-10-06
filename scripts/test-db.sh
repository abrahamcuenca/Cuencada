#!/usr/bin/env bash
# Manage the disposable Postgres container used by the Vitest server suite.
#
# Usage: scripts/test-db.sh up|down|status
#
# The container keeps its data on tmpfs, so `down` (or a reboot) wipes it.
# It only ever touches the container named below; other local databases
# (for example jmxinc-dev-db) are left alone.
set -euo pipefail

CONTAINER_NAME="cuencada-test-db"
HOST_PORT="55432"
IMAGE="docker.io/library/postgres:16-alpine"
DB_USER="cuencada"
DB_PASSWORD="cuencada"
DB_NAME="cuencada_test"
READY_TIMEOUT_SECONDS="${CUENCADA_TEST_DB_TIMEOUT:-60}"

require_podman() {
  if ! command -v podman >/dev/null 2>&1; then
    echo "test-db: podman is not installed or not on PATH" >&2
    exit 1
  fi
}

container_exists() {
  podman container exists "$CONTAINER_NAME"
}

container_running() {
  [ "$(podman inspect --format '{{.State.Running}}' "$CONTAINER_NAME" 2>/dev/null)" = "true" ]
}

is_ready() {
  # pg_isready can succeed during the image's init phase (a temporary server
  # on the unix socket), so also require a real query over TCP.
  podman exec "$CONTAINER_NAME" pg_isready -h 127.0.0.1 -U "$DB_USER" -d "$DB_NAME" >/dev/null 2>&1 &&
    podman exec -e PGPASSWORD="$DB_PASSWORD" "$CONTAINER_NAME" \
      psql -h 127.0.0.1 -U "$DB_USER" -d "$DB_NAME" -tAc 'select 1' >/dev/null 2>&1
}

wait_until_ready() {
  local waited=0
  until is_ready; do
    if [ "$waited" -ge "$READY_TIMEOUT_SECONDS" ]; then
      echo "test-db: $CONTAINER_NAME was not ready after ${READY_TIMEOUT_SECONDS}s" >&2
      podman logs --tail 30 "$CONTAINER_NAME" >&2 || true
      exit 1
    fi
    sleep 1
    waited=$((waited + 1))
  done
}

# Mark this cluster as the disposable test container. The e2e harness
# (tests/e2e/harness/dbGuard.ts) refuses to DROP/CREATE databases on a cluster
# without this marker, so a mistyped URL aimed at a tunnel to production fails
# closed. A database-level setting: idempotent, and applied to an already
# running (older) container without recreating it.
mark_test_cluster() {
  podman exec -e PGPASSWORD="$DB_PASSWORD" "$CONTAINER_NAME" \
    psql -h 127.0.0.1 -U "$DB_USER" -d postgres -v ON_ERROR_STOP=1 -qtAc \
    "ALTER DATABASE postgres SET cuencada.test_cluster = 'cuencada-test'" >/dev/null
}

cmd_up() {
  require_podman
  if container_running; then
    echo "test-db: $CONTAINER_NAME already running"
  elif container_exists; then
    echo "test-db: starting existing $CONTAINER_NAME"
    podman start "$CONTAINER_NAME" >/dev/null
  else
    echo "test-db: creating $CONTAINER_NAME on 127.0.0.1:$HOST_PORT"
    podman run -d \
      --name "$CONTAINER_NAME" \
      -p "127.0.0.1:${HOST_PORT}:5432" \
      --tmpfs /var/lib/postgresql/data \
      -e POSTGRES_USER="$DB_USER" \
      -e POSTGRES_PASSWORD="$DB_PASSWORD" \
      -e POSTGRES_DB="$DB_NAME" \
      "$IMAGE" >/dev/null
  fi
  wait_until_ready
  mark_test_cluster
  echo "test-db: ready at postgresql://${DB_USER}:***@127.0.0.1:${HOST_PORT}/${DB_NAME}"
}

cmd_down() {
  require_podman
  if container_exists; then
    podman rm -f "$CONTAINER_NAME" >/dev/null
    echo "test-db: removed $CONTAINER_NAME"
  else
    echo "test-db: $CONTAINER_NAME is not present"
  fi
}

cmd_status() {
  require_podman
  if container_running; then
    if is_ready; then
      echo "test-db: $CONTAINER_NAME running and accepting connections on 127.0.0.1:$HOST_PORT"
    else
      echo "test-db: $CONTAINER_NAME running but not ready yet"
      exit 2
    fi
  elif container_exists; then
    echo "test-db: $CONTAINER_NAME exists but is stopped"
    exit 3
  else
    echo "test-db: $CONTAINER_NAME is not present"
    exit 3
  fi
}

case "${1:-}" in
  up) cmd_up ;;
  down) cmd_down ;;
  status) cmd_status ;;
  *)
    echo "usage: $0 up|down|status" >&2
    exit 64
    ;;
esac
