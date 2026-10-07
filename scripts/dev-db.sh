#!/usr/bin/env bash
# Manage the local development Postgres (podman), for `pnpm dev`.
#
# Usage: scripts/dev-db.sh up|status|psql|stop|down [--delete-data]
#
#   up      create (or start) the container and wait until it accepts queries
#   status  report whether it is running and ready
#   psql    open psql inside the container (extra args are passed to psql)
#   stop    stop the container; the data stays in the named volume
#   down    remove the container; the volume (your data) is KEPT unless you
#           also pass --delete-data
#
# Data lives in the named volume below, so it survives `stop`, `down` and
# reboots. It only ever touches this container and volume: the disposable
# test database (cuencada-test-db on 55432, scripts/test-db.sh) and any other
# local databases are left alone. Dev-only credentials; never reuse them.
set -euo pipefail

CONTAINER_NAME="cuencada-dev-db"
VOLUME_NAME="cuencada-dev-db-data"
HOST_PORT="55433"
IMAGE="docker.io/library/postgres:16-alpine"
DB_USER="cuencada"
DB_PASSWORD="cuencada-dev"
DB_NAME="cuencada"
READY_TIMEOUT_SECONDS="${CUENCADA_DEV_DB_TIMEOUT:-60}"

require_podman() {
  if ! command -v podman >/dev/null 2>&1; then
    echo "dev-db: podman is not installed or not on PATH" >&2
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
      echo "dev-db: $CONTAINER_NAME was not ready after ${READY_TIMEOUT_SECONDS}s" >&2
      podman logs --tail 30 "$CONTAINER_NAME" >&2 || true
      exit 1
    fi
    sleep 1
    waited=$((waited + 1))
  done
}

cmd_up() {
  require_podman
  if container_running; then
    echo "dev-db: $CONTAINER_NAME already running"
  elif container_exists; then
    echo "dev-db: starting existing $CONTAINER_NAME"
    podman start "$CONTAINER_NAME" >/dev/null
  else
    echo "dev-db: creating $CONTAINER_NAME on 127.0.0.1:$HOST_PORT (volume $VOLUME_NAME)"
    podman volume exists "$VOLUME_NAME" || podman volume create "$VOLUME_NAME" >/dev/null
    podman run -d \
      --name "$CONTAINER_NAME" \
      -p "127.0.0.1:${HOST_PORT}:5432" \
      -v "${VOLUME_NAME}:/var/lib/postgresql/data" \
      -e POSTGRES_USER="$DB_USER" \
      -e POSTGRES_PASSWORD="$DB_PASSWORD" \
      -e POSTGRES_DB="$DB_NAME" \
      "$IMAGE" >/dev/null
  fi
  wait_until_ready
  echo "dev-db: ready at postgresql://${DB_USER}:***@127.0.0.1:${HOST_PORT}/${DB_NAME}"
}

cmd_status() {
  require_podman
  if container_running; then
    if is_ready; then
      echo "dev-db: $CONTAINER_NAME running and accepting connections on 127.0.0.1:$HOST_PORT"
    else
      echo "dev-db: $CONTAINER_NAME running but not ready yet"
      exit 2
    fi
  elif container_exists; then
    echo "dev-db: $CONTAINER_NAME exists but is stopped (scripts/dev-db.sh up)"
    exit 3
  else
    echo "dev-db: $CONTAINER_NAME is not present (scripts/dev-db.sh up)"
    exit 3
  fi
}

cmd_psql() {
  require_podman
  if ! container_running; then
    echo "dev-db: $CONTAINER_NAME is not running (scripts/dev-db.sh up)" >&2
    exit 3
  fi
  local tty=()
  [ -t 0 ] && [ -t 1 ] && tty=(-it)
  podman exec "${tty[@]}" -e PGPASSWORD="$DB_PASSWORD" "$CONTAINER_NAME" \
    psql -h 127.0.0.1 -U "$DB_USER" -d "$DB_NAME" "$@"
}

cmd_stop() {
  require_podman
  if container_running; then
    podman stop "$CONTAINER_NAME" >/dev/null
    echo "dev-db: stopped $CONTAINER_NAME (data kept in volume $VOLUME_NAME)"
  else
    echo "dev-db: $CONTAINER_NAME is not running"
  fi
}

cmd_down() {
  require_podman
  local delete_data="false"
  case "${1:-}" in
    "") ;;
    --delete-data) delete_data="true" ;;
    *)
      echo "usage: $0 down [--delete-data]" >&2
      exit 64
      ;;
  esac
  if container_exists; then
    podman rm -f "$CONTAINER_NAME" >/dev/null
    echo "dev-db: removed $CONTAINER_NAME"
  else
    echo "dev-db: $CONTAINER_NAME is not present"
  fi
  if [ "$delete_data" = "true" ]; then
    if podman volume exists "$VOLUME_NAME"; then
      podman volume rm "$VOLUME_NAME" >/dev/null
      echo "dev-db: deleted volume $VOLUME_NAME (all local dev data is gone)"
    fi
  else
    echo "dev-db: kept volume $VOLUME_NAME; pass --delete-data to delete it"
  fi
}

command="${1:-}"
[ "$#" -gt 0 ] && shift
case "$command" in
  up) cmd_up ;;
  status) cmd_status ;;
  psql) cmd_psql "$@" ;;
  stop) cmd_stop ;;
  down) cmd_down "$@" ;;
  *)
    echo "usage: $0 up|status|psql|stop|down [--delete-data]" >&2
    exit 64
    ;;
esac
