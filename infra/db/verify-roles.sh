#!/usr/bin/env bash
# Prove infra/db/roles.sql on the disposable podman Postgres (scripts/test-db.sh,
# port 55432) — never on any other database:
#
#   1. create a scratch database and the two roles with roles.sql
#   2. migrate as the OWNER role (node apps/server/dist/db/migrate.js)
#   3. seed and run the built API as the RUNTIME role
#   4. assert the runtime role can't do DDL, TRUNCATE, temp tables or read the
#      migrator's bookkeeping
#   5. run scripts/deploy-smoke.mjs against the API (login, forced password
#      change, /me, edition, chat ticket + WebSocket)
#   6. drop the scratch database and roles
#
# Usage: pnpm build && scripts/test-db.sh up && infra/db/verify-roles.sh [suffix]
#   suffix (default "w24") names cuencada_<suffix>, cuencada_owner_<suffix>,
#   cuencada_app_<suffix>. KEEP=1 leaves the API running and skips the cleanup
#   (it prints the cleanup commands).
set -euo pipefail

CONTAINER="cuencada-test-db"
PG_PORT="55432"
SUPERUSER="cuencada"
SUFFIX="${1:-w24}"
[[ "$SUFFIX" =~ ^[a-z0-9_]+$ ]] || { echo "verify-roles: suffix must match [a-z0-9_]+" >&2; exit 2; }
DB="cuencada_${SUFFIX}"
OWNER="cuencada_owner_${SUFFIX}"
APP="cuencada_app_${SUFFIX}"
API_PORT="${API_PORT:-3994}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

OWNER_PW="$(openssl rand -hex 24)"
APP_PW="$(openssl rand -hex 24)"
OWNER_URL="postgresql://${OWNER}:${OWNER_PW}@127.0.0.1:${PG_PORT}/${DB}"
APP_URL="postgresql://${APP}:${APP_PW}@127.0.0.1:${PG_PORT}/${DB}"

podman container exists "$CONTAINER" || { echo "verify-roles: run scripts/test-db.sh up first" >&2; exit 1; }
[[ -f "$ROOT/apps/server/dist/index.js" ]] || { echo "verify-roles: run pnpm build first" >&2; exit 1; }

superuser() { podman exec -i "$CONTAINER" psql -X -q -v ON_ERROR_STOP=1 -U "$SUPERUSER" "$@"; }
# The image trusts loopback connections, so the runtime role connects to the
# container's own non-loopback address, where pg_hba demands scram-sha-256:
# the password (and the SCRAM verifier it was stored as) is really checked.
CONTAINER_IP="$(podman exec "$CONTAINER" hostname -i | awk '{print $1}')"
as_app() { podman exec -i -e PGPASSWORD="$APP_PW" "$CONTAINER" psql -X -q -h "$CONTAINER_IP" -U "$APP" -d "$DB" "$@"; }
as_owner() { podman exec -i -e PGPASSWORD="$OWNER_PW" "$CONTAINER" psql -X -q -h "$CONTAINER_IP" -U "$OWNER" -d "$DB" "$@"; }

API_PID=""
CRED_DIR=""
cleanup() {
  [[ -n "$API_PID" ]] && kill "$API_PID" 2>/dev/null || true
  [[ -n "$CRED_DIR" ]] && rm -rf "$CRED_DIR"
  superuser -d postgres -c "DROP DATABASE IF EXISTS ${DB} WITH (FORCE)" >/dev/null
  superuser -d postgres -c "DROP ROLE IF EXISTS ${APP}" -c "DROP ROLE IF EXISTS ${OWNER}" >/dev/null
}
if [[ "${KEEP:-0}" != "1" ]]; then trap cleanup EXIT; fi

step() { printf '\n==> %s\n' "$*"; }
fail() { echo "FAIL  $*" >&2; exit 1; }

step "reset scratch database ${DB} and roles"
cleanup

step "apply infra/db/roles.sql (twice: it must be idempotent; it takes no passwords)"
for _ in 1 2; do
  superuser -d postgres -v db_name="$DB" -v owner_role="$OWNER" -v app_role="$APP" -f - < "$ROOT/infra/db/roles.sql"
done
if as_app -tAc "select 1" >/dev/null 2>&1; then fail "the runtime role logged in before a password was set"; fi
echo "PASS  no password set yet: the runtime role can't log in (fails closed)"

step "set the passwords as SCRAM verifiers (infra/db/scram-verifier.mjs; plain passwords never reach Postgres)"
OWNER_VERIFIER="$(printf '%s' "$OWNER_PW" | node "$ROOT/infra/db/scram-verifier.mjs")"
APP_VERIFIER="$(printf '%s' "$APP_PW" | node "$ROOT/infra/db/scram-verifier.mjs")"
superuser -d postgres -v role="$OWNER" -v verifier="$OWNER_VERIFIER" <<'SQL'
ALTER ROLE :"role" PASSWORD :'verifier';
SQL
superuser -d postgres -v role="$APP" -v verifier="$APP_VERIFIER" <<'SQL'
ALTER ROLE :"role" PASSWORD :'verifier';
SQL
superuser -d postgres -tAc "select rolname from pg_authid where rolname in ('${OWNER}', '${APP}') and rolpassword like 'SCRAM-SHA-256\$%'" | grep -c . | grep -qx 2 \
  || fail "the stored passwords are not SCRAM verifiers"
echo "PASS  both roles store a SCRAM-SHA-256 verifier"
as_app -tAc "select 1" >/dev/null 2>&1 || fail "the runtime role can't log in with its password over scram-sha-256"
as_owner -tAc "select 1" >/dev/null 2>&1 || fail "the owner role can't log in with its password over scram-sha-256"
if podman exec -i -e PGPASSWORD=wrong-password "$CONTAINER" psql -X -q -h "$CONTAINER_IP" -U "$APP" -d "$DB" -tAc "select 1" >/dev/null 2>&1; then
  fail "the runtime role logged in with a wrong password"
fi
echo "PASS  scram-sha-256 logins work with the verifier-set passwords and refuse a wrong one"

step "migrate as the owner role"
MIGRATE_DATABASE_URL="$OWNER_URL" DATABASE_URL="" node "$ROOT/apps/server/dist/db/migrate.js"

step "runtime role: allowed and denied operations"
as_app -tAc "select count(*) from users" >/dev/null || fail "runtime role can't read users"
deny() {
  local label="$1" sql="$2"
  if as_app -c "$sql" >/dev/null 2>&1; then fail "runtime role could: ${label}"; fi
  echo "PASS  denied: ${label}"
}
deny "CREATE TABLE"            "create table w24_probe (id int)"
deny "CREATE TEMP TABLE"       "create temp table w24_probe (id int)"
deny "DROP TABLE"              "drop table audit_logs"
deny "ALTER TABLE"             "alter table users add column w24 int"
deny "TRUNCATE"                "truncate audit_logs"
deny "CREATE SCHEMA"           "create schema w24"
deny "read drizzle bookkeeping" "select * from drizzle.__drizzle_migrations"
deny "CREATE INDEX"            "create index w24_idx on users (email)"
superuser -d "$DB" -tAc "select 1 from pg_tables where schemaname = 'public' and tableowner <> '${OWNER}'" | grep -q 1 \
  && fail "a public table is not owned by ${OWNER}"
echo "PASS  every public table is owned by ${OWNER}"

step "seed as the runtime role (development fixtures)"
NODE_ENV=development DATABASE_URL="$APP_URL" node "$ROOT/apps/server/dist/seed.js"
# The seeded admin starts unverified (chat and media need a verified email);
# stand in for the verify-email click, which also proves UPDATE works.
as_app -tAc "update users set email_verified_at = now() where email = 'admin@cuencada.com'" >/dev/null \
  || fail "runtime role can't update users"

step "start the built API as the runtime role on 127.0.0.1:${API_PORT}, secrets from CREDENTIALS_DIRECTORY"
# Same shape as systemd LoadCredential=: one 0600 file per secret in a 0700
# directory; DATABASE_URL and JWT_SECRET are NOT in the environment.
CRED_DIR="$(mktemp -d "${TMPDIR:-/tmp}/w24-verify-roles-creds.XXXXXX")"
chmod 0700 "$CRED_DIR"
( umask 077; printf '%s\n' "$APP_URL" > "$CRED_DIR/DATABASE_URL"; openssl rand -hex 32 > "$CRED_DIR/JWT_SECRET" )
env -u DATABASE_URL -u JWT_SECRET NODE_ENV=development HOST=127.0.0.1 PORT="$API_PORT" LOG_LEVEL=warn \
  APP_BASE_URL="http://127.0.0.1:${API_PORT}" CORS_ORIGIN="http://127.0.0.1:${API_PORT}" \
  CREDENTIALS_DIRECTORY="$CRED_DIR" \
  node "$ROOT/apps/server/dist/index.js" &
API_PID=$!
for _ in $(seq 1 50); do
  curl -fsS "http://127.0.0.1:${API_PORT}/health/ready" >/dev/null 2>&1 && break
  sleep 0.2
done
curl -fsS "http://127.0.0.1:${API_PORT}/health/ready" | grep -q '"db":true' || fail "/health/ready is not ready"
echo "PASS  /health/ready reports db:true as the runtime role"

step "smoke test (login, forced password change, /me, edition, chat WebSocket)"
SMOKE_BASE_URL="http://127.0.0.1:${API_PORT}" SMOKE_STATIC=0 SMOKE_HEALTH_PATH=/health \
  SMOKE_EMAIL=admin@cuencada.com SMOKE_PASSWORD='Password123!' SMOKE_NEW_PASSWORD="W24-$(openssl rand -hex 12)" \
  node "$ROOT/scripts/deploy-smoke.mjs"

if [[ "${KEEP:-0}" == "1" ]]; then
  echo
  echo "KEEP=1: API pid ${API_PID} still on 127.0.0.1:${API_PORT}. Clean up with:"
  echo "  kill ${API_PID}"
  echo "  podman exec ${CONTAINER} psql -U ${SUPERUSER} -d postgres -c 'DROP DATABASE IF EXISTS ${DB} WITH (FORCE)' -c 'DROP ROLE IF EXISTS ${APP}' -c 'DROP ROLE IF EXISTS ${OWNER}'"
  wait "$API_PID"
fi
echo
echo "verify-roles: OK"
