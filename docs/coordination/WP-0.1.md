# WP-0.1 Test infra (podman PG, Vitest, CI)
Owner: Backend · Reviewers: TL · Branch: wp/0.1-test-infra · PR: #

## Scope
- `scripts/test-db.sh up|down|status`: idempotent podman `postgres:16-alpine` named `cuencada-test-db`, tmpfs data, bound to `127.0.0.1:55432`, waits for `pg_isready` plus a real TCP query. Never touches other containers (e.g. `jmxinc-dev-db`). The plan mentioned `compose.test.yml`; no compose provider is installed, so a script replaces it.
- mise: `test:db:up`, `test:db:down`, `test:db:status`; `test` now depends on `test:db:up`.
- `.env.example`: `TEST_DATABASE_URL=postgresql://cuencada:cuencada@127.0.0.1:55432/cuencada_test`.
- Root `vitest.config.ts` with `test.projects`: `server` (node), `web` (jsdom), `types` (node). `@cuencada/types` is aliased to `packages/types/src/index.ts`.
- Per-package `test` scripts plus a turbo `test` task (`cache: false`). Root `pnpm test` still runs `vitest run` for all projects in one process.
- Server harness in `apps/server/test/` (see Interfaces).
- Web: `jsdom`, Testing Library (react, dom, jest-dom, user-event) and `msw@^2` as devDeps; `apps/web/test/setup.ts`; one smoke test (`SiteHeader.test.tsx`).
- `.github/workflows/ci.yml`: Node 24, pnpm from `packageManager`, a Postgres 16 service on 55432, then install (frozen), lint, typecheck, test, prod audit.

## Interfaces consumed / exposed

### Seam changes to app.ts / config.ts
**None.** `buildApp(config: AppConfig)` already takes a config object. `createTestApp` builds a validated config through `loadConfig({...explicit env})`. It does not read `process.env`, so a local `.env` cannot redirect tests to a real DB.

`buildApp` does not close its postgres pool on `app.close()`, so `createTestApp` adds an `onClose` hook that calls `app.db.$client.end()`. **WP-0.4:** once `buildApp` registers its own `onClose`/SIGTERM handling, delete that hook from `test/helpers/app.ts`. A double `end()` is harmless, but the hook becomes redundant.

### Harness (apps/server/test)
| File | Exposes |
|---|---|
| `env.ts` | `TEST_DATABASE_URL` (env or default), `workerDatabaseName()` / `workerDatabaseUrl()` (`cuencada_test_<VITEST_POOL_ID>`) |
| `globalSetup.ts` | Drops leftover harness DBs, creates `cuencada_template`, runs `migrate()` from `drizzle-orm/postgres-js/migrator` on `apps/server/drizzle`, and flags it as a template. Teardown drops the template and every `cuencada_test_<n>` |
| `setup.ts` (setupFiles) | `beforeAll` lazily clones the worker DB from the template; **`beforeEach` calls `resetDb()` automatically**; `afterAll` closes the client |
| `helpers/db.ts` | `getTestDb(): Database` (same schema-typed drizzle as the app), `resetDb()` (TRUNCATE all `public` tables except `__drizzle_migrations`, RESTART IDENTITY CASCADE), `ensureWorkerDatabase()`, `closeTestDb()` |
| `helpers/app.ts` | `createTestApp({ config?: Partial<AppConfig> })`, `createTestConfig()` |
| `helpers/factories.ts` | `createUser({ email, displayName, role, status, password, mustChangePassword, profile })` returns the user row plus `password` and `profile`; `loginAs(app, user)` returns `{ headers: { authorization: "Bearer …" } }` via `POST /api/auth/login` |
| `helpers/fakes.ts` | `FakeMailer` (`outbox`, `send`, `lastTo`, `clear`) and `FakeStorage` (`objects`, `presignedPuts`, `presignPut`, `presignGet`, `head`, `getRange`, `put`, `delete`, `simulateUpload`) |

Usage: `const app = await createTestApp(); const user = await createUser({ role: "admin" }); const auth = await loginAs(app, user); await app.inject({ method: "GET", url: "/api/me", ...auth });`

### Contracts for WP-0.4 to implement
- `apps/server/src/lib/mailer/types.ts`: `Mailer.send(MailMessage) → Promise<{ id }>`. `MailMessage = { to, subject, html, text, replyTo?, tags? }`. One recipient per message. Bodies must never be logged because they carry tokens.
- `apps/server/src/lib/storage/types.ts`: `StorageService` with `presignPut({ key, contentType, contentLength, expiresInSeconds? }) → { url, method: "PUT", headers, expiresAt }`, `presignGet({ key, expiresInSeconds?, responseContentDisposition? }) → { url, expiresAt }`, `head(key) → ObjectHead | null`, `getRange(key, start, endInclusive) → Uint8Array` (for magic-byte sniffing), `put({ key, body, contentType, cacheControl? })`, `delete(key)` (idempotent). Object keys are always server-generated.
- **Expected follow-up (WP-0.4):** make `buildApp` accept injected services, e.g. `buildApp(config, { mailer?, storage? })`, and extend `TestAppOverrides` in `test/helpers/app.ts` with `mailer` and `storage`, defaulting to `new FakeMailer()` / `new FakeStorage()`.

## Decisions
- **Project roots are per package** (`apps/server`, `apps/web`, `packages/types`), not the repo root. Vite resolves SSR externals from the project root, and with pnpm `drizzle-orm` and similar packages are only linked under `apps/server/node_modules`. A repo-root project root fails with `Cannot find package 'drizzle-orm/postgres-js'`. Include globs are therefore package-relative (`**/*.test.ts`, `**/*.test.{ts,tsx}`).
- Worker DBs are cloned lazily in `setup.ts` (not in globalSetup) because the worker count is only known at runtime. Concurrent clones retry on `55006 object in use`, and `42P04 duplicate` is treated as success.
- Automatic `resetDb()` before every server test favours isolation over speed. TRUNCATE of about 17 tables takes a few ms.
- Factory passwords are hashed with cheap argon2id params (`m=4096,t=2,p=1`). `argon2.verify` reads params from the hash, so the production code path is unchanged.
- Server test files are type-checked through a new `apps/server/tsconfig.test.json` (`typecheck` runs both configs); the build config still excludes tests. `apps/web/tsconfig.json` now includes `test/`.
- `msw` pinned to `^2` because `@vitest/mocker@3` peers on `msw@^2`. The msw postinstall is disabled (`allowBuilds: msw: false`) because it only copies a browser worker script. Without that entry, `pnpm install` exits non-zero on pnpm 11.
- The test container binds to `127.0.0.1` only, not `0.0.0.0`.
- Login with a malformed body currently returns **500** (zod throws and there is no error handler). The test asserts 500 today, and an `it.todo` marks the 400 case for WP-0.4.
- Running two `vitest` processes against the same test cluster at once is unsupported, because both use `cuencada_test_<poolId>` names and the same template.

## Open questions (→ orchestrator)
- WP-0.4: confirm the `buildApp(config, deps)` injection shape above so `createTestApp` can pass the fakes.
- WP-0.3: the schema split and migration 0001 need no harness change. `globalSetup` migrates whatever is in `apps/server/drizzle`. If the migrator script moves the migrations folder or changes `migrationsSchema`, update `globalSetup.ts`.
- The local `mise.toml` in a fresh worktree must be `mise trust`ed before `mise run test` works. CI calls pnpm directly.

## Review log
- (pending TL review)
