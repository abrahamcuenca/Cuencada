# WP-3.1b Navigation by session state + local development out of the box
Owner: Senior JS Frontend (with UI/UX; small backend/devops piece) · Reviewers: TL, Security · Branch: wp/3.1b-nav-and-local-dev · PR: # (not opened)

Based on `origin/main` (`8a41310`). Runs next to WP-3.1a, which owns Home's hero/status logic, the year page, RSVP, contracts and a migration. This WP touches only the "Todo en un solo lugar" section of `HomePage.tsx` (and puts its Home tests in a separate file).

## Why
From the owner's local testing: links to member-only pages (Directorio, Árbol, Admin…) looked dead to visitors who weren't logged in, because they only bounced to `/entrar`; a member opening `/admin` was silently sent home. Local development was also hard to start: the seeded admin was unverified and the dev mailer printed no links, `.env.example` had a placeholder seed password, there was no dev Postgres helper, the README was outdated, and `pnpm dev` failed on a fresh clone (`packages/*/dist` never built).

## Scope
### B. Navigation by session state (web)
- `features/auth/authSlice.ts`: `selectSessionAudience` → `pending | anonymous | member | admin`.
- `app/AppLayout.tsx`: `topNavItems(audience, …)` and `bottomNavItems(audience, …)` (both exported and tested); `SessionAction` uses the audience.

| Audience | TopNav (≥900px) | BottomNav (mobile) | Header action |
|---|---|---|---|
| pending (boot refresh in flight: `idle`/`restoring`) | Programa | Inicio, Programa | none |
| anonymous | Inicio, Programa | Inicio, Programa, Entrar (🔑) | Entrar |
| member (verified or not) | Programa, Galería, Directorio, Árbol, Chat | Inicio, Programa, Fotos, Chat, Más | Salir |
| admin | the member links + **Panel** | the member tabs (Panel is in `/mas`) | Salir |

- "Panel" copy: TopNav **Panel**; `/mas` row **Panel de administración**; console `h1` **Panel de administración**; console back links **‹ Panel**; the user sheet's demotion warning says "…ya no podrá entrar al Panel de administración". The `/admin` route is unchanged.
- `features/auth/guards.tsx` `RequireAdmin`: a logged-in non-admin gets **"Acceso restringido"** / "Esta sección es solo para administradores." plus "Volver al inicio" (`components/AdminRestricted.tsx`, lazy, built on `AccessDeniedState`, which gained optional `forbiddenDescription`, `forbiddenAction` and `headingLevel={1}`; `EmptyState` accepts `headingLevel` 1). The URL stays `/admin/...`. Anonymous visitors are still sent to `/entrar` with `state.from` by `RequireAuth`.
- Home "Todo en un solo lugar": members (verified or not) see every highlight. Anonymous visitors see the public Programa card plus one compact dashed teaser: 🔒 "Inicia sesión para ver el directorio, el árbol familiar, las fotos y el chat" + **Entrar**. While the session is restoring, only the public card shows. At ≥900px the teaser spans the three columns next to Programa; alone (no edition yet) it spans the row.
- `/mas` was already member-only and shows the admin row only for `role === "admin"` (test kept, label updated).

### C. Local development
- **Dev mailer** (`apps/server/src/lib/mailer/dev.ts`): see Decisions 2. `createMailer` throws in production when Resend isn't configured, before it would construct the dev mailer (config already requires `RESEND_API_KEY`/`MAIL_FROM` there, and the constructor refuses production too).
- **`scripts/dev-db.sh`** `up | status | psql | stop | down [--delete-data]`: podman `postgres:16-alpine`, container `cuencada-dev-db`, `127.0.0.1:55433`, named volume `cuencada-dev-db-data`, db `cuencada`, user `cuencada` / password `cuencada-dev` (dev-only). `down` keeps the volume unless `--delete-data` is passed; unknown flags exit 64. It never touches `cuencada-test-db` (55432) or other containers.
- **`.env.example`**: `DATABASE_URL` and `MIGRATE_DATABASE_URL` point at `127.0.0.1:55433`; `SEED_ADMIN_TEMP_PASSWORD=` is empty (dev/test fall back to `Password123!`, production needs a strong vault value); new `SEED_DEV_VERIFY_ADMIN=`; the mail comment describes the dev mailer.
- **Seed** `SEED_DEV_VERIFY_ADMIN`: `1/true/yes/on` sets the admin's `email_verified_at` (on insert, or on a re-run when it is still null); `0/false/no/off`/blank is off. Any non-blank value when `NODE_ENV` is not exactly `development` throws `SeedConfigError` (production, test, staging, unset). The seed reads `process.env`, not `config.ts`, so nothing was added to config validation. `SeedResult` gained `adminEmailVerified`. The deploy preflight already forbids `SEED_*` in `infra/project.yml`, so it can't reach the VPS.
- **`pnpm dev` from a fresh clone**: `turbo.json` `dev` now `dependsOn: ["^build"]`, the root script is `turbo dev` (the deprecated `--parallel` discarded the task graph, so `^build` never ran), and `packages/types` / `packages/emails` have `dev` = `tsc --watch` (persistent, next to `tsx watch` and Vite). `passThroughEnv` on `dev` lets shell overrides (`HOST`, `PORT`, `LOG_LEVEL`, `APP_BASE_URL`, `CORS_ORIGIN`, `DEV_ALLOWED_ORIGINS`, `CUENCADA_DEV_*`) through turbo's strict env mode.
- `apps/web/vite.config.ts`: optional `CUENCADA_DEV_PORT` (strict port) and `CUENCADA_DEV_API_ORIGIN` (proxy target), to run a second checkout next to the first. Defaults unchanged.
- **README** rewritten (what it is, layout, Run locally, tests, deploy/security links). **AGENTS.md** Commands mention `pnpm dev`, `scripts/dev-db.sh` and `pnpm e2e`.

## Decisions
1. **Restoring-state nav: neutral, not last-known.** Auth state is memory-only by design (no token or user in storage), so there is no last-known state to show at boot. While `status` is `idle`/`restoring`, the navs show only the public destinations (TopNav: Programa; BottomNav: Inicio, Programa) and no Entrar/Salir. A returning member goes neutral → member, never through the anonymous nav (unit test dispatches `tokenRefreshed` mid-render and records the tabs). An anonymous visitor goes neutral → anonymous (one tab added). Offline at boot keeps the neutral nav, and guarded pages show their offline state.
2. **Dev mailer output channel: a framed block on stdout, plus a body-less Pino event.** Every message logs `info` `{ event: "dev.mail", mail: { id, to, subject, category }, printed }`, never the body. Only under `NODE_ENV=development` the whole plain-text message is also written to `process.stdout` as a readable block (Para / Asunto / Categoría / Id, then the text with the links). Why not the logger for the body: the body carries live one-time tokens; log lines are what gets shipped and retained (journald → Loki), and pino-pretty would flatten a multi-line body into one escaped string. The stdout block is a deliberate developer-console channel that never enters the structured log stream, and it can't run in production (the class refuses to be constructed there and `createMailer` never selects it). It isn't `console.log`: the writer is injected (tests capture it). Under `NODE_ENV=test` nothing is printed.
3. **Restricted screen keeps the URL** (`/admin/...`), with a link home instead of a redirect, so the user can see why. It is lazy-loaded because `AccessDeniedState` imports the resend-verification button (authApi), which must stay out of the initial chunk (bundle budget).
4. **Admin console headings were renamed too** ("Panel de administración", "‹ Panel"), so the link and the page it opens match.
5. **Home tests live in `HomePage.highlights.test.tsx`**, to stay clear of WP-3.1a's edits in `HomePage.test.tsx`.
6. **E2E journey screenshots under `docs/ux/screenshots/e2e/` were not refreshed** (they changed only by the new nav; WP-3.1a is changing Home too). Refresh both with `E2E_UPDATE_DOCS=1 pnpm e2e` after both merge.

## Tests
- Web: `AppLayout.test.tsx` (anonymous, verified and unverified member, admin, idle/restoring; restoring → member never shows the anonymous tabs), `guards.test.tsx` (restricted screen for verified and unverified members, URL kept; anonymous `/admin` → `/entrar` with `state.from`), `AdminDashboard.test.tsx` and `AdminMediaPage.test.tsx` (restricted, no admin API call), `MorePage.test.tsx` (no Panel row for members), `HomePage.highlights.test.tsx` (teaser vs member links, members verified/unverified/admin, restoring, teaser alone).
- Server: `mailer.test.ts` (test prints nothing; development prints the whole message including the invite, magic-link, verify and reset links; the log never carries the token; refuses production; `createMailer` never picks it in production; block format), `seed.test.ts` (verify on insert, on re-run, untouched when already verified; flag parsing; refused for production/test/staging/unset `NODE_ENV`).
- E2E: new `tests/e2e/nav.spec.ts` (journey 11, on both phones and desktop): anonymous navs + teaser → `/entrar`; member nav, `/mas` without Panel, `/admin` restricted → home; admin Panel → console. `auth.spec.ts` heading renamed; `quality.spec.ts` gates the member's `/admin` restricted screen at 320/375 + axe. `support/fixtures.ts` gained `docShot` (375/1280 doc screenshots, `E2E_UPDATE_DOCS=1` only).

## Screenshots
`docs/ux/screenshots/nav/{anonymous,member,admin,restricted}-{375,1280}.webp` (fictional e2e cast; generated by `E2E_UPDATE_DOCS=1` runs of `nav.spec.ts`).

## Verification (2026-10-07)
See the PR description for the final command log. Followed the README from a clean state in this worktree: deleted `packages/*/dist`, `apps/server/dist` and `.env`, ran `scripts/dev-db.sh down --delete-data`, then every README step with `TURBO_FORCE=true` (no turbo cache). `pnpm dev` built both packages before starting the API and Vite. Ports 3006/5173 belonged to the owner's checkout, so the run used the README's documented override (API 3016, Vite 5183). Through the Vite proxy: login `admin@cuencada.com` / `Password123!` → `mustChangePassword: true` → change password → verify request (202) → the verify link printed in the dev terminal → confirm (204) → `GET /api/me` `emailVerified: true`. `SEED_DEV_VERIFY_ADMIN=1` re-run verified an unverified admin; `NODE_ENV=test` with the flag failed with the SeedConfigError. A `packages/types` edit recompiled it and restarted the API.

## Review log
