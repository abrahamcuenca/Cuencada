# WP-0.1 Test infra (podman PG, Vitest, CI)
Owner: Backend · Reviewers: TL · Branch: wp/0.1-test-infra · PR: #1

## Scope
- `scripts/test-db.sh up|down|status`: idempotent podman `postgres:16-alpine` named `cuencada-test-db`, tmpfs data, bound to `127.0.0.1:55432`, waits for `pg_isready` plus a real TCP query. Never touches other containers (e.g. `jmxinc-dev-db`). No compose provider is installed, so a script is used instead of a compose file (`docs/plan.md` updated).
- mise: `test:db:up`, `test:db:down`, `test:db:status`; `test` now depends on `test:db:up`.
- `.env.example`: `TEST_DATABASE_URL=postgresql://cuencada:cuencada@127.0.0.1:55432/cuencada_test`.
- Root `vitest.config.ts` with `test.projects`: `server` (node), `web` (jsdom), `types` (node). `@cuencada/types` is aliased to `packages/types/src/index.ts`.
- Per-package `test` scripts plus a turbo `test` task (`cache: false`). Root `pnpm test` still runs `vitest run` for all projects in one process.
- Server harness in `apps/server/test/` (see Interfaces).
- Web: `jsdom`, Testing Library (react, dom, jest-dom, user-event) and `msw@^2` as devDeps; `apps/web/test/setup.ts`; one smoke test (`SiteHeader.test.tsx`).
- `.github/workflows/ci.yml`: Node 24, pnpm from `packageManager`, a Postgres 16 service on 55432, then install (frozen), lint, typecheck, test, prod audit. All actions are pinned by commit SHA (`actions/checkout` v7.0.1, `actions/setup-node` v7.0.0, `pnpm/action-setup` v6.1.0), with `persist-credentials: false`.

## Interfaces consumed / exposed

### Seam changes to app.ts / config.ts
**None.** `buildApp(config: AppConfig)` already takes a config object. `createTestApp` builds a validated config through `loadConfig({...explicit env})`. It does not read `process.env`, so a local `.env` cannot redirect tests to a real DB.

`buildApp` does not close its postgres pool on `app.close()`, so `createTestApp` adds an `onClose` hook that calls `app.db.$client.end()`. **WP-0.4:** once `buildApp` registers its own `onClose`/SIGTERM handling, delete that hook from `test/helpers/app.ts`. A double `end()` is harmless, but the hook becomes redundant.

### Harness (apps/server/test)
| File | Exposes |
|---|---|
| `env.ts` | `TEST_DATABASE_URL` (env or default; **validated**: loopback host and a DB name ending in `_test`, and `CUENCADA_TEST_DB_ALLOW_REMOTE=1` lifts only the loopback check), `createRunId()`, `templateDatabaseName(run)`, `workerDatabaseName(run, poolId)`, `parseHarnessDatabaseName()` |
| `globalSetup.ts` | Generates a run id `<epochSeconds>_<hex6>` and `provide`s it as `testRunId`. Creates `cuencada_tpl_<run>` and runs `migrate()` from `drizzle-orm/postgres-js/migrator` on `apps/server/drizzle`. Reclaims only **stale** harness DBs from other runs: older than 1h, with no `pg_stat_activity` connection, and dropped without `FORCE`. Teardown drops only this run's DBs |
| `setup.ts` (setupFiles) | `beforeAll` lazily clones the worker DB from the template; **`beforeEach` calls `resetDb()` automatically**; `afterAll` closes the client |
| `helpers/db.ts` | `currentRunId()` (via `inject`), `currentWorkerDatabaseName()` / `workerDatabaseUrl()` (`cuencada_test_<run>_<VITEST_POOL_ID>`), `getTestDb(): Database` (same schema-typed drizzle as the app), `resetDb()` (TRUNCATE all `public` tables except `__drizzle_migrations`, RESTART IDENTITY CASCADE), `ensureWorkerDatabase()`, `closeTestDb()` |
| `helpers/app.ts` | `createTestApp({ config?: Partial<AppConfig> })`, `createTestConfig()` |
| `helpers/factories.ts` | `createUser({ email, displayName, role, status: TestUserStatus, password, mustChangePassword, profile })` returns the user row plus `password` and `profile`; `loginAs(app, user)` returns `{ headers: { authorization: "Bearer …" } }` via `POST /api/auth/login` |
| `helpers/fakes.ts` | `FakeMailer` (`outbox`, `send` (honours `idempotencyKey`), `lastTo`, `clear`) and `FakeStorage` (`objects`, `presignedPuts`, `presignPut`, `presignGet`, `head`, `getRange`, `put`, `delete`, `simulateUpload`) |

Usage: `const app = await createTestApp(); const user = await createUser({ role: "admin" }); const auth = await loginAs(app, user); await app.inject({ method: "GET", url: "/api/me", ...auth });`

### Contracts for WP-0.4 to implement
- `apps/server/src/lib/mailer/types.ts`: `Mailer.send(MailMessage) → Promise<{ id }>`. `MailMessage = { to, subject, html, text, replyTo?, tags?, idempotencyKey? }`. One recipient per message. `idempotencyKey` maps to Resend's `Idempotency-Key`; derive it from the operation, never from the token. Bodies must never be logged because they carry tokens.
- `apps/server/src/lib/storage/types.ts`: `StorageService` with `presignPut({ key, contentType, contentLength, expiresInSeconds? }) → { url, method: "PUT", requiredHeaders, signed: { contentType, contentLength }, expiresAt }`. `requiredHeaders` holds only what the browser must set itself (`content-type`, any `x-amz-*`), never `content-length`, which is a forbidden header. The length is enforced by signing it. **WP-0.4:** verify on Linode that a PUT with a mismatched body is rejected; if it is not, rely on the post-upload `head()` size check, `presignGet({ key, expiresInSeconds?, responseContentDisposition? }) → { url, expiresAt }`, `head(key) → ObjectHead | null`, `getRange(key, start, endInclusive) → Uint8Array` (for magic-byte sniffing), `put({ key, body, contentType, cacheControl? })`, `delete(key)` (idempotent). Object keys are always server-generated.
- **Expected follow-up (WP-0.4):** make `buildApp` accept injected services, e.g. `buildApp(config, { mailer?, storage? })`, and extend `TestAppOverrides` in `test/helpers/app.ts` with `mailer` and `storage`, defaulting to `new FakeMailer()` / `new FakeStorage()`.

## Decisions
- **Project roots are per package** (`apps/server`, `apps/web`, `packages/types`), not the repo root. Vite resolves SSR externals from the project root, and with pnpm `drizzle-orm` and similar packages are only linked under `apps/server/node_modules`. A repo-root project root fails with `Cannot find package 'drizzle-orm/postgres-js'`. Include globs are therefore package-relative (`**/*.test.ts`, `**/*.test.{ts,tsx}`).
- Worker DBs are cloned lazily in `setup.ts` (not in globalSetup) because the worker count is only known at runtime. Concurrent clones retry with jitter on `55006 object in use`, and `42P04 duplicate` is treated as success.
- **Concurrent runs are supported.** Every DB is namespaced by run id, so several worktrees can share the one `cuencada-test-db` container. The template is no longer flagged `is_template`, because the owner can clone it without that flag. `createUser`'s `status` is a local `TestUserStatus` union until WP-0.2 adds a shared `UserStatus`.
- Automatic `resetDb()` before every server test favours isolation over speed. TRUNCATE of about 17 tables takes a few ms.
- Factory passwords are hashed with cheap argon2id params (`m=4096,t=2,p=1`). `argon2.verify` reads params from the hash, so the production code path is unchanged.
- Server test files are type-checked through a new `apps/server/tsconfig.test.json` (`typecheck` runs both configs); the build config still excludes tests. `apps/web/tsconfig.json` now includes `test/`.
- `msw` pinned to `^2` because `@vitest/mocker@3` peers on `msw@^2`. The msw postinstall is disabled (`allowBuilds: msw: false`) because it only copies a browser worker script. Without that entry, `pnpm install` exits non-zero on pnpm 11.
- The test container binds to `127.0.0.1` only, not `0.0.0.0`.
- Login with a malformed body currently returns **500** (zod throws and there is no error handler). The test asserts 500 today, and an `it.todo` marks the 400 case for WP-0.4.

## Open questions (→ orchestrator)
- WP-0.4: confirm the `buildApp(config, deps)` injection shape above so `createTestApp` can pass the fakes.
- WP-0.3: the schema split and migration 0001 need no harness change. `globalSetup` migrates whatever is in `apps/server/drizzle`. If the migrator script moves the migrations folder or changes `migrationsSchema`, update `globalSetup.ts`.
- The local `mise.toml` in a fresh worktree must be `mise trust`ed before `mise run test` works. CI calls pnpm directly.

## Review log
- **TL review 1 (CHANGES REQUESTED)**, addressed:
  - B1, concurrent runs clobbering each other: fixed with run-namespaced DBs, own-run-only teardown, and stale-only reclaim (older than 1h, no connections, no `FORCE`). Proof with two overlapping `pnpm vitest run --project server` runs started 0.6s apart:
    ```
    harness DBs seen while running:
    cuencada_test_1791275111_5ff899_1 .. _3   cuencada_tpl_1791275111_5ff899
    cuencada_test_1791275112_99d72e_1 .. _3   cuencada_tpl_1791275112_99d72e
    run1 exit=0  Tests 18 passed | 1 todo (19)  Start at 01:25:11  Duration 5.35s
    run2 exit=0  Tests 18 passed | 1 todo (19)  Start at 01:25:12  Duration 4.96s
    left over: cuencada_test
    ```
    Stale reclaim was checked by hand: a planted `cuencada_test_1000000000_abcdef_1` was dropped on the next run, and a planted, non-stale `cuencada_tpl_9999999999_abcdef` was left alone.
  - B2: `scripts/test-db.sh` is now mode 100755 in git.
  - 3: `TEST_DATABASE_URL` guard added, with unit tests in `test/env.test.ts`.
  - 4: `PresignedPut` split into `requiredHeaders` + `signed`; the fake is aligned.
  - 5: `MailMessage.idempotencyKey`; `FakeMailer` dedupes on it.
  - 6: `createUser` takes `status: TestUserStatus`.
  - 7: actions bumped to current majors and SHA-pinned.
  - 8: WP-0.4 checklist: **delete** the "returns a 500 for a malformed body" test and implement the `it.todo`.
  - 9: jitter added.
  - 10: root vitest is now `^3.2.7`.
  - 11: `docs/plan.md` now references `scripts/test-db.sh`.
