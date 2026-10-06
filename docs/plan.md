# Cuencada: from scaffold to a working app (multi-agent plan)

## Context
Codex/opencode left a pnpm/turbo monorepo (`apps/web`, `apps/server`, `packages/types`) that is almost all scaffolding, and none of it is committed to git.

**Server: what already works**
- argon2 login with a 15-minute HS256 JWT
- change-password
- admin create and publish of a Cuencada
- S3 presigned PUT

**Server: still stubs**
- Magic link and invite accept. The invite stub returns 501 and leaks a token hash prefix.
- Chat always returns `[]`.
- The public Cuencada GETs return a hardcoded object from `modules/cuencadas/data.ts`.
- Missing pieces:
  - no error handler (invalid input gives a 500)
  - no refresh tokens
  - `mustChangePassword` is not enforced
  - only one test (`/health`)

**Web**
- It never calls the API.
- Login is a fake "Demo admin" that writes an admin user to `localStorage`, so anyone can make themselves admin.
- 5 of 8 pages are placeholder text and the countdown is frozen.
- No PWA, no Redux, no tests.

**Legacy site**
- `index.html` is the real content source: programa, lugares, clima, canción, tips, WhatsApp, OneDrive, and the daily messages in `mensajes.txt`.
- Cuencada 2026 (Sept 13–18) is already over, so status must be calculated from dates. The home page shows "memories" mode until the next edition is published.

**Goal**: ship a complete, secure, **mobile-first** family portal: auth (invites, magic link, password reset, refresh rotation), Cuencada content, RSVP and attendance, private photo/video gallery, profile and directory, family tree, real-time chat, admin console, PWA.

**Decisions you made**:
- All features built in parallel tracks
- Resend + React Email
- WebSocket chat
- Redux Toolkit + RTK Query
- A branch and GitHub PR per work package, with Tech Lead + Security approval before merge (you merge)
- A dedicated podman postgres:16 test container

---

## Team and orchestration

| Role | Implemented as | Owns |
|---|---|---|
| **Orchestrator / Sr. JS engineer** (me) | Main session | Sequencing, dispatching work packages (WPs), resolving conflicts between agents, integration, keeping this plan current |
| **Software Architect** | Agent (Plan/general-purpose) | Contracts in `packages/types`, schema/migration design, ADRs in `docs/adr/`, reviewing cross-track interfaces |
| **UI/UX Web Designer** | Agent | **Mobile-first** design system, wireframes in `docs/ux/`, tokens and primitives, PWA icons, copy tone in Spanish |
| **Sr. JS Frontend Engineer** | Agent(s), one per track, in a git worktree | `apps/web/src/features/<f>/**` |
| **Sr. JS Backend Engineer** | Agent(s), one per track, in a git worktree | `apps/server/src/modules/<m>/**` |
| **Tech Lead (code review)** | Agent | Reviews every PR with `gh pr review`. **An approval is required to finalize a WP.** Owns `AGENTS.md`, CI, the PR template |
| **Security Engineer** | Agent | OWASP Top 10 / ASVS review on every PR marked **[SEC]** plus a final audit. A second approval is required on those PRs |

### How agents coordinate and communicate
- **Single source of truth.**
  - The plan moves into the repo as `docs/plan.md`. It holds the WP table with status, owner, branch and PR link.
  - Each WP has a handoff file `docs/coordination/WP-x.y.md` covering scope, the interfaces it consumes and exposes, open questions, and the review log.
- **Messaging.**
  - I dispatch agents with the Agent tool. Each implementation agent gets `isolation: "worktree"` and its own branch `wp/<id>-<slug>`.
  - Agents ask questions across tracks through me. Example: the Frontend agent asks the Backend agent about a response shape.
  - I relay with SendMessage to the running agent, or resume that agent. Decisions are written into the handoff file so nothing lives only in chat.
- **Contract-first.** The Architect freezes the zod schemas in `packages/types/src/<module>.ts` before the FE and BE agents start a track. FE and BE build against the same contract in parallel. FE uses MSW mocks until the BE PR merges.
- **Review loop, for each WP:**
  1. The implementer opens the PR. It must pass `mise run verify` and CI.
  2. The Tech Lead agent and, for **[SEC]** PRs, the Security agent review in parallel and post their reviews on the PR.
  3. I send "request changes" findings back to the implementer, who fixes them and pushes. The reviewers re-review the changes.
  4. The WP is **final only when the required approvals are on the PR**. You then merge, or tell me to.
- **Parallelism cap.** About 6–8 agents at once: 2–3 implementation tracks, each FE + BE, plus the reviewers. This limits merge churn.

### Mobile-first requirement (hard gate)
- The UI/UX agent designs every screen at **360–414px first** and adds breakpoints with `min-width` only (about 600, 900 and 1200px). Desktop is an enhancement.
- Navigation:
  - a **bottom tab bar** on mobile: Inicio, Programa, Fotos, Chat, Más
  - a top nav at ≥900px
  - this fixes the legacy site, which hid the nav on mobile with no replacement
- Touch targets are at least 44×44px. Body text is at least 16px so iOS doesn't zoom form fields.
- Layout:
  - respect `env(safe-area-inset-*)`
  - no horizontal scroll at 320px
  - forms use the right `inputmode` and `autocomplete`
- Uploads open the camera roll through `accept="image/*,video/*"` and `multiple`. Upload progress is visible, and the gallery uses one thumb-friendly lightbox with swipe.
- Performance budget on a mid-range phone over 4G: LCP under 2.5s, JS under 200KB gzip on the initial route (routes are lazy-loaded), responsive WebP thumbnails.
- Accessibility: WCAG 2.2 AA contrast, visible focus, `prefers-reduced-motion`.
- **Gate:** the Tech Lead rejects any UI PR without screenshots at 375px and 1280px. Phase 2 Playwright runs every flow on a mobile viewport (iPhone 13 / Pixel 7 profiles) plus Lighthouse mobile, with a target of 90+ for performance, accessibility and best practices.

---

## Architecture (Architect's design, summarized)

### Auth and sessions [SEC]
**Tokens**
- **Access token:** a JWT of 10–15 min with claims `sub`, `sid`, `role` and `mcp`. It is kept **only in memory** in the Redux `authSlice`.
- **Refresh token:** opaque, made with the existing `createOpaqueToken()` and stored hashed with `hashToken()` (in `apps/server/src/auth.ts`, moving to `lib/tokens.ts`). It goes in the cookie `__Secure-cuencada_rt` with HttpOnly, Secure, SameSite=Strict and Path=/api/auth.

**Rotation**
- A new `refresh_tokens` table.
- Refresh runs in a transaction with `SELECT … FOR UPDATE`.
- Presenting a token that was already used after a 20s grace window revokes the session and writes an audit entry.
- Within the grace window the server answers 409 `REFRESH_RACE`. The client serializes refreshes with `navigator.locks` and broadcasts logout to other tabs with `BroadcastChannel`.

**Guards**
- A global auth guard that **denies by default** (`config.auth: public | user | admin`).
- Every request checks the DB session (revocation, disabled users, role).
- `mustChangePassword` is enforced: 403 `PASSWORD_CHANGE_REQUIRED` everywhere except `/me`, change-password, logout and refresh.

**CSRF on refresh/logout**
- SameSite=Strict
- a required `X-Cuencada-CSRF` header
- an exact `Origin` check

**Invite, magic-link and reset flows**
- Tokens are hashed and single-use.
- The token travels in the URL **fragment**, and the SPA POSTs it to consume it. This keeps tokens out of logs and Referer headers, and stops email scanners from burning them.
- The invite inspect endpoint is a POST.
- Responses are generic, with no account enumeration.
- **Remove the `tokenHashPreview` leak.**

**Rate limits** are per route, keyed by IP and email, with `trustProxy: true`.

**WebSocket auth**
- A single-use 30s ticket from `POST /api/chat/ticket`.
- The `Origin` is checked on upgrade.
- Sockets are closed when their session is revoked.

**Config**
- In production, require `SEED_ADMIN_TEMP_PASSWORD` (today it silently defaults to `Password123!`) and require `JWT_SECRET` to be at least 32 chars.
- Add `APP_BASE_URL`, `RESEND_API_KEY`, `MAIL_FROM`, `COOKIE_SECURE` and the TTL settings.

### Schema: migration 0001 (single owner)
**Conventions**
- `text` columns with CHECK constraints, mirrored as `as const` objects plus zod enums. No pg enums.
- Split `db/schema.ts` into `db/schema/<module>.ts`.

**Changes by area**
- **Auth:**
  - unique `lower(email)`
  - unique token-hash indexes
  - new `refresh_tokens`
  - `sessions` gets idle/absolute expiry and `revoked_reason`
- **People and family:**
  - `profiles.user_id` becomes NOT NULL UNIQUE
  - visibility flags added to profiles
  - **new `people`** table, so tree nodes can be people without accounts
  - `family_relationships` is replaced by `person_relationships` (parent_of / partner_of, self-reference check)
- **Cuencada content:**
  - new columns on `cuencadas`: `timezone`, `song_url`, `whatsapp_url`, `weather_widget_url`, `rsvp_deadline`
  - itinerary `date` plus `start_time`/`end_time`/`price_note`
  - richer locations
  - RSVP CHECK constraints
  - **new `cuencada_attendance`** for historical attendance
- **Media:**
  - `upload_status`, `thumb_key`/`display_key`, dimensions, soft delete, moderation fields
  - **new `daily_messages`**, seeded from `mensajes.txt`
- **Chat:**
  - partial uniques for the global and per-Cuencada rooms
  - read state
  - keyset index
- **Audit:** `audit_logs.metadata` becomes `jsonb` and gains an `ip` column.

**Migrations in production.** Replace the `drizzle-kit migrate` call, which uses a devDependency, with a migrator script built on drizzle-orm and included in the bundle. The migration is tested against a seeded 0000 database.

**Seed.** It becomes idempotent: the admin user, the full 2026 Cuencada built from `data.ts` and the legacy content, the daily messages, and the global chat room.

### API and contracts
- Zod schemas live in `packages/types/src/<module>.ts`; zod 4 also works in the browser. Response models are JSDoc'd interfaces. The index barrel is pre-filled once and then frozen.
- The server uses `fastify-type-provider-zod` with **response schemas**, so hidden PII fields cannot be serialized. The web reuses the same schemas for its forms.
- Route groups:
  - auth/invites
  - profile/directory
  - public and member Cuencada reads
  - RSVP
  - media
  - family
  - chat (REST + WebSocket)
  - announcements
  - admin (CRUD for every entity, attendance bulk, daily-message import, invites, users, media moderation, audit logs)
  - `/health/ready`
- Every admin change is audit-logged with `recordAudit(tx, …)`.

### Media pipeline [SEC]
**Storage**
- Private Linode bucket. Lists return **presigned GET** URLs (1h) for the thumbnail and display copies.

**Upload flow**
1. `POST …/media/uploads`. The server checks the type allowlist and size, inserts a `pending_upload` row, and returns a presigned PUT that is bound to the content type and length.
2. The browser PUTs the file directly to the bucket.
3. `POST /media/:id/confirm` runs a HEAD request plus a magic-byte check.
4. An in-process job re-reads the original and re-checks its size and magic bytes, then:
   - images (**sharp**): auto-rotates, **strips EXIF/GPS**, makes a 1600px WebP display copy and a 400px WebP thumbnail
   - videos (pure JS, no ffmpeg): **neutralizes location/identifying metadata in place** (`udta` incl. `©xyz`, `meta` incl. the QuickTime ISO6709 location key, `uuid`/XMP become same-size zeroed `free` boxes, so chunk offsets stay valid) and writes the result to its own display key
   - only the sanitized copies are ever served; the original is deleted afterwards (and on any failure)
   - items interrupted by a restart are marked failed, never re-run (no crash loop)
5. A cleanup job removes abandoned uploads and re-sweeps leftover objects of deleted/failed items.
6. Per-user limits: intents/min, open intents, and a rolling 24 h byte budget.

**Moderation:** items are auto-approved, members can report them, and admins hide or delete them. A flag can switch this to approval first.

**Reuse:** move the S3 code from `modules/gallery/routes.ts` behind a `StorageService` interface. Tests use a fake implementation.

### Frontend
- `app/` holds the store, router and providers. `shared/` holds `api/baseApi.ts` (re-auth mutex), `ui/` primitives with CSS Modules, `styles/tokens.css` (from the current `styles.css` palette `#0b5e55`, `#e7b84b`, `#fffaf0`) and `lib/dates.ts` (`es-MX`, using the Cuencada's timezone).
- `features/<f>/{api.ts,routes.tsx,pages,components}`, with every route lazy-loaded.
- Chat streams with RTK Query `onCacheEntryAdded` and reconnects with backoff.
- The family tree is a custom, **mobile-friendly person-centred view**: parents, partners and children around one person, tap to navigate. No heavy tree library.
- PWA uses `vite-plugin-pwa`:
  - NetworkFirst only for the public Cuencada API, so the programa still works offline on the trip
  - NetworkOnly for everything else
  - caches cleared on logout
  - an update prompt
- Spanish-only copy. Errors carry a machine-readable `code`.
- Legacy production links are kept exactly: OneDrive, WhatsApp, weatherwidget, hotel links, Google Maps.

---

## Work packages

### Phase 0: foundation (mostly in sequence; nothing parallel starts until it's done)
| WP | Owner → reviewers | Scope |
|---|---|---|
| 0.0 | Tech Lead | **Baseline commit** of the current scaffold to `main` and push. Add `tsbuildinfo` and `.turbo` to ignores. Fix the `pnpm-workspace.yaml` argon2 placeholder. PR template with checklist (mobile screenshots, tests, security items), CODEOWNERS, `docs/plan.md` |
| 0.1 | Backend → TL | `scripts/test-db.sh` (`up`/`down`/`status`; podman `postgres:16-alpine`, 127.0.0.1:55432, tmpfs; run-namespaced test DBs). Root `vitest.config.ts` projects (server/node, web/jsdom, types). Template-DB-per-worker setup. Factories, `loginAs`, fake Mailer and fake Storage. `.github/workflows/ci.yml` with a Postgres service. Wire turbo `test` |
| 0.2 | Architect → TL, Sec | All module contracts in `packages/types` (zod + interfaces + `ErrorCode`), frozen barrel |
| 0.3 | Backend (data) → Architect, TL | Schema split, migration 0001, migrator script, migration test, idempotent seed |
| 0.4 | Backend → TL, **Sec** | Error handler (zod → 400), type provider, default-deny guard plus `sid` session check plus must-change gate, cookie, websocket, `trustProxy`, DB `onClose`/SIGTERM, `lib/{tokens,passwords,audit,mailer,storage}`, every module registered as a stub, **all server deps installed**, config hardening |
| 0.5 | Frontend + UI/UX → TL | `packages/emails` (React Email, Spanish templates: invite, magic link, reset, password changed, verify email) |
| 0.6 | Frontend → TL, Sec | Store, `authSlice`, `baseApi` with re-auth, lazy router with feature stubs, guards. **Remove the demo admin.** Vite `ws` proxy. **All web deps installed** |
| 0.7 | **UI/UX** (+FE) → TL | **Mobile-first** tokens and primitives (Button, Field, Card, Dialog, BottomNav, AvatarCircle, Toast, Lightbox, EmptyState, PageShell), wireframes for every feature in `docs/ux/`, PWA maskable icons, legacy assets migrated into `apps/web/public/` |

### Phase 1: parallel tracks (each a BE WP plus an FE WP; each owns only its own folders)
| Track | Backend | Frontend (mobile-first) |
|---|---|---|
| T1 Auth **[SEC]** | login, refresh rotation and reuse detection, logout and sessions, change password, magic link, reset, verify email, invites create/inspect/accept, rate limits | `/entrar`, `/invitacion`, `/recuperar`, `/restablecer`, `/cambiar-contrasena`, sessions list |
| T2 Cuencadas | DB-backed public and member reads, calculated status, admin CRUD (cuencadas, itinerary, locations, daily messages incl. `YYYY-MM-DD\|msg` import, announcements) | Home (memories mode or upcoming hero), `/cuencada/:year` ported from legacy sections, live countdown, admin content screens |
| T3 RSVP & attendance | RSVP me and summary, admin attendance bulk, attendees union, CSV export | RSVP card, attendee circles, admin attendance |
| T4 Media **[SEC]** | uploads, confirm, sharp worker, cleanup, presigned list, report, moderation | `/galeria/:year`, camera-roll uploader with progress, swipe lightbox, admin queue |
| T5 Profile & directory **[SEC]** | profile, avatar (via T4 storage), directory with visibility enforced by response schemas | `/perfil`, `/directorio` |
| T6 Family tree **[SEC]** | people and relationships, depth-limited recursive CTE, cycle checks, self-edit | `/arbol/:personId?`, admin people editor |
| T7 Chat | rooms, keyset history, ticket, WebSocket hub, read state, moderation, 25s ping | `/chat`, streaming cache, unread badges |
| T8 Admin console | users (disabling revokes sessions), audit log query | admin shell, users, invites, audit viewer |
| T9 PWA | none | manifest, service worker, update prompt, cache purge on logout |

**Run order**
1. **Wave A:** T1, T2, T4. Auth unblocks everything, and content plus gallery are the most visible features.
2. **Wave B:** T3, T5, T6.
3. **Wave C:** T7, T8, T9.

**Rules that prevent conflicts**
- Only 0.3 and 2.1 touch `db/schema/**` and `drizzle/**`. Tracks file schema requests and they are batched into 0002.
- Only Phase 0 touches `app.ts`, `config.ts`, `router.tsx`, `store.ts`, `baseApi.ts` and the types barrel.
- Dependencies are installed up front. If a track still needs a new one, it rebases and runs `pnpm install` rather than hand-merging the lockfile.

### Phase 2: integration and hardening
| WP | Owner | Scope |
|---|---|---|
| 2.1 | Backend (data) | Migration 0002 with all column requests from Phase 1 |
| 2.2 | Frontend + UI/UX | Playwright E2E on **mobile viewports** (invite → login → forced change → RSVP → upload → chat), Lighthouse mobile at 90+, a11y pass |
| 2.3 | **Security** | Threat model, an **authorization-matrix test** (every route × anonymous/member/admin/other member), PII leak tests, IDOR checks, helmet CSP (weatherwidget, S3 origin, wss), `pnpm audit`, dependency review, final OWASP Top 10 sign-off |
| 2.4 | TL + Backend | `infra/project.yml` env and vault refs (`vault_cuencada_resend_api_key`, `APP_BASE_URL`), bucket CORS and lifecycle, Resend DNS (SPF/DKIM/DMARC), argon2 and sharp native-build check against the VPS, `mise run deploy-check`. **Deploying needs your explicit approval** |
| 2.5 | Admin (you) + UI/UX | Load historical Cuencadas, attendance and family tree data |

---

## Critical files
- `apps/server/src/{app.ts,config.ts,auth.ts,seed.ts}`, `apps/server/src/db/schema.ts` (to be split), `apps/server/drizzle/`
- `apps/server/src/modules/{auth,cuencadas,gallery,chat}/routes.ts` (stubs to replace) and `modules/cuencadas/data.ts` (move into the seed)
- `packages/types/src/index.ts`
- `apps/web/src/app/{router.tsx,auth.tsx}` (`auth.tsx` will be deleted), `apps/web/src/styles.css` (becomes the tokens), `apps/web/src/data/cuencada2026.ts` (delete)
- `infra/project.yml`, `mise.toml`, `pnpm-workspace.yaml`, `.env.example`
- Legacy references: `index.html`, `mensajes.txt`, `images/`, `canciones/`

## Verification
- **For every PR:**
  - `mise run verify`: lint, typecheck, Vitest against the podman Postgres (`scripts/test-db.sh up`, run automatically by `mise run test`), prod audit
  - CI green
  - Tech Lead approval, plus Security approval on [SEC] PRs
  - 375px and 1280px screenshots for UI changes
- **Backend:** Fastify `inject()` tests on every route: happy path, 400, 401/403. Service and DB tests against real Postgres. Specific tests for refresh-token reuse and races, invite single use, the must-change gate, and directory visibility.
- **Frontend:** Testing Library + MSW for components and RTK Query flows.
- **End-to-end:**
  - `pnpm --filter @cuencada/server dev` plus `pnpm --filter @cuencada/web dev`
  - Playwright mobile profiles cover the full journey
  - a manual check on a real phone through the Vite LAN host
- **Pre-deploy:** `mise run deploy-check` (dry run). The real deploy happens only after you approve it.

## Open items for later (not blocking)
- Resend API key, plus DNS access for cuencada.com verification
- Linode bucket CORS and lifecycle access
- Historical Cuencada data and family tree source (spreadsheet?) for 2.5
