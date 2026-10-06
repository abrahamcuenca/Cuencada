# WP-0.8a Platform & repo hygiene [SEC]
Owner: Senior SWE (platform) · Reviewers: TL, Sec · Branch: wp/0.8a-platform-hygiene · PR: #

## Scope
1. `docs/coordination/backlog.md` (grouped Done / Open by owner / cutover checklist) and the README status table.
2. `logging.ts` `scrubUrl`: query-param **allowlist** instead of a denylist.
3. `ErrorCode.EMAIL_UNVERIFIED` (403) for `requireVerifiedEmail` failures.
4. `drizzle.config.ts` guard against `push`/`drop`.
5. AGENTS.md rules (fictional fixtures, no PII in errors, agent git/scratch hygiene, merge main + full suite, backlog).
6. Privacy sweep outside `features/**` (forward only, no history rewrite).
7. Flaky tests and worker limits.
8. Vitest 4.1.11.
9. shared/ui: BottomNav 320 px, Badge `max`, Toast eviction.
10. packages/emails nits.

## Interfaces consumed / exposed
- **`ErrorCode.EMAIL_UNVERIFIED`** (403, `packages/types/src/common.ts`). The auth guard answers it when a `requireVerifiedEmail` route is called with an unverified email; default message "Confirma tu correo electrónico para ver esta sección.". Before, this was 403 `FORBIDDEN`. WP-0.8c makes the web accept both.
- **Logged query parameters**: only `limit`, `year`, `status`, `role`, `kind`, `depth`, `before`, `scope`, `entityType`, `action` keep their values, and only when the value matches `^[A-Za-z0-9_.:=-]{0,128}$`. Every other parameter becomes `name=[REDACTED]`; a pair whose decoded name is not a plain identifier becomes `[REDACTED]`. Matching is exact on the decoded name, so `Limit`, `q[]`, `%71` are redacted. `before` is allowed because the chat cursor encodes only `(created_at, id)`; `cursor` stays redacted. Add a parameter to `LOGGABLE_QUERY_PARAMS` only if its values are enums, numbers or opaque ids.
- **`assertDrizzleCommandAllowed`** (`apps/server/src/db/drizzle-guard.ts`), called by `drizzle.config.ts`.
- **`warmRoutes(...paths)`** (`apps/web/test/renderApp.tsx`): preloads lazy route modules in `beforeAll`.
- **`Badge` `max` prop** and `formatCount`; **`evictForNewToast`** / `MAX_VISIBLE_TOASTS` in `Toast.tsx`.
- **`CONTAINER_WIDTH_PX`** (emails): the Container table carries `width="600"`.

## Decisions
- Vitest 4 needed no config changes beyond `maxWorkers` (top level, replaces `poolOptions`). `test.projects`, `project.provide`/`inject`, per-project `esbuild` and `environment` work unchanged with Vite 7.
- `maxWorkers: "50%"` (override with `VITEST_MAX_WORKERS`).
- drizzle-kit's deprecated `@esbuild-kit/core-utils` pulls esbuild 0.18 (dev-server advisory). It is overridden to `^0.25.12` in `pnpm-workspace.yaml`; `drizzle-kit check`/`generate` verified.
- Privacy sweep: "Familia Cuenca" stays only as the portal/brand name (web `index.html`, seed chat-room title). The StyleGuide uses generated SVG placeholder photos instead of the legacy family photos, and a placeholder WhatsApp link. The real legacy links remain only in `seed-data.ts` `LEGACY_DEV_LINKS` (dev/test fallback, reset at cutover).
- Module tests owned by 0.8b were touched only for the `EMAIL_UNVERIFIED` assertions, fixture names/phones and the admin race-test timeout (line-local edits).

## Open questions (→ orchestrator)
- None.

## Review log
