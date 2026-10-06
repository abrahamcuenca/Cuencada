-- Cuencada: separate database roles (WP-2.4). PostgreSQL 15+ (production: 18).
--
-- Two LOGIN roles:
--   owner role   (:owner_role) owns the database, the public schema and every
--                table. Only the migrator (and the one-off seed) use it:
--                MIGRATE_DATABASE_URL, from the operator's machine through the
--                SSH tunnel. Never on the VPS.
--   runtime role (:app_role) is what the API on server_1 runs as, over the VPC:
--                DATABASE_URL (server.credentials, vault_cuencada_database_url).
--                DML on the app tables and sequence usage only. No DDL, no
--                TRUNCATE, no REFERENCES/TRIGGER, no access to the migrator's
--                bookkeeping (schema "drizzle"), cannot create schemas, tables
--                or temp tables.
--
-- Run ONCE as a superuser (postgres) with psql on the DB server, before the
-- first migration. The script takes NO passwords (they would land in shell
-- history, `ps` output and the server log):
--
--   psql -v ON_ERROR_STOP=1 \
--        -v db_name=cuencada -v owner_role=cuencada_owner -v app_role=cuencada_app \
--        -d postgres -f infra/db/roles.sql
--
-- Then set each password interactively, in the same psql session or a new one:
--
--   \password cuencada_owner
--   \password cuencada_app
--
-- `\password` prompts without echo and sends only a SCRAM-SHA-256 verifier
-- (computed client-side), so the plain password never reaches the server, its
-- logs or pg_stat_activity. Alternative for a non-interactive setup: compute
-- the verifier locally with infra/db/scram-verifier.mjs (reads the password
-- from stdin) and run `ALTER ROLE … PASSWORD '<SCRAM-SHA-256$…>'`.
--
-- Passwords: `openssl rand -hex 32` (hex only: nothing to URL-encode in the
-- connection string). Never commit them; store them in the vault
-- (vault_cuencada_database_url / vault_cuencada_migrate_database_url).
-- Until a password is set the role can't log in (fails closed).
--
-- Re-running is safe: roles and the database are created only when missing,
-- passwords are left alone, and the grants are idempotent.

\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------------
-- Roles (cluster-wide)
-- ---------------------------------------------------------------------------
SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS', :'owner_role')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'owner_role') \gexec
SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT CONNECTION LIMIT 30', :'app_role')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'app_role') \gexec


-- Runtime guard rails: a stuck transaction or a runaway query can't hold locks
-- or a pool slot forever. (The API's longest statements are batched cleanups.)
ALTER ROLE :"app_role" SET idle_in_transaction_session_timeout = '60s';
ALTER ROLE :"app_role" SET statement_timeout = '30s';

-- ---------------------------------------------------------------------------
-- Database, owned by the owner role
-- ---------------------------------------------------------------------------
SELECT format('CREATE DATABASE %I OWNER %I ENCODING ''UTF8'' TEMPLATE template0', :'db_name', :'owner_role')
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'db_name') \gexec
ALTER DATABASE :"db_name" OWNER TO :"owner_role";

-- Nobody connects or creates temp tables by default; grant exactly what's needed.
REVOKE ALL ON DATABASE :"db_name" FROM PUBLIC;
GRANT CONNECT, TEMPORARY ON DATABASE :"db_name" TO :"owner_role";
GRANT CONNECT ON DATABASE :"db_name" TO :"app_role";

\connect :"db_name"

-- ---------------------------------------------------------------------------
-- Schema public: owner creates, runtime only uses
-- ---------------------------------------------------------------------------
ALTER SCHEMA public OWNER TO :"owner_role";
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA public TO :"owner_role";
GRANT USAGE ON SCHEMA public TO :"app_role";

-- Existing objects (none on a fresh database; covers a re-run after migrations).
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO :"app_role";
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO :"app_role";

-- Future objects: every table and sequence the migrator (owner role) creates
-- is usable by the runtime role without another manual grant.
ALTER DEFAULT PRIVILEGES FOR ROLE :"owner_role" IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO :"app_role";
ALTER DEFAULT PRIVILEGES FOR ROLE :"owner_role" IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO :"app_role";

-- The migrator's bookkeeping schema ("drizzle") is created by the owner role on
-- the first migration and is not granted to the runtime role.
