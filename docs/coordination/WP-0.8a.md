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
- **Logged query parameters** (strict after Security L1, PR #31): `LOGGABLE_QUERY_PARAMS` maps each loggable name to a value check:
  - `limit`/`year`/`depth`: digits only;
  - `status`/`role`/`kind`/`scope`/`entityType`/`action`/`moderationStatus`/`uploadStatus`: the contract enum values (`UserStatus` ∪ `InviteStatus`, `UserRole`, `MediaKind`, `AnnouncementScope`, `AuditEntityType`, `AuditAction`, …);
  - `reported`/`emailVerified`: `true`/`false`;
  - `before`: plain base64url (the chat cursor encodes only `(created_at, id)`).

  A value that fails its check is redacted. Known API parameters (`q`, `search`, `cursor`, `ticket`, `token`, `city`, `familyBranch`, ids, `from`/`to`) are logged as `name=[REDACTED]`; any other or undecodable name (including case variants and `q[]`) is logged as `[param]=[REDACTED]`, because a name can carry data too.
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

## PR #31 round 1 (Security M1/L1, Tech Lead N1–N3)
- **Real family photos are members-only (owner decision).** Deleted `apps/web/public/images/fotos/foto01–04.jpg`. The legacy root `index.html`, `cuencada2026.html` and root `images/` are untouched (live legacy site; retirement is on the cutover checklist). The public HomePage mosaic (`features/cuencadas`, 0.8c) still points at the deleted files and 404s until 0.8c replaces it.
- **Deleted screenshots that showed the real photos** (owners re-take them with placeholders):
  - T2 (0.8c): `docs/ux/screenshots/t2/home-memories-375.webp`, `home-memories-1280.webp`
  - T4 (0.8c): `docs/ux/screenshots/t4/grid-*`, `lightbox-*`, `upload-sheet-*`, `upload-progress-*`, `admin-queue-*` (375 and 1280)
  - T9 (0.8c): `docs/ux/screenshots/t9/offline-home-375.webp` (the mosaic peeks under the toast)
  - WP-0.7 (orchestrator): `docs/ux/screenshots/styleguide-375.webp`, `styleguide-1280.webp`, `overlays-375.webp`, `lightbox-1280.webp`
  - Checked and kept (no photos): T2 `cuencada-2026-*`, `dialog-1280`, `web-foundation/layout-375`, T9 install/update/offline-programa.

## Open questions (→ orchestrator)
- None.

## Review log
