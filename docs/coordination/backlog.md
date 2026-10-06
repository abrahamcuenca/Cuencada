# Backlog

Deferred and cross-track work, grouped by status. Imported from the
orchestrator's working backlog by WP-0.8a (2026-10-06) and checked against
`main` after PRs #1–#30. Add new items here instead of leaving TODOs in code.
When an item ships, move it to **Done** with the PR number.

Owners: **0.8a** platform & repo hygiene · **0.8b** backend modules (auth,
family, profile, admin, chat, media, cuencadas) · **0.8c** web features
(`apps/web/src/features/**`) ·
**WP-2.x** later phase (2.1 migrations, 2.4–2.5 cutover).

## Done

| Item | Delivered by |
|---|---|
| Contracts reject names made only of invisible chars (U+3164, U+2060, U+00AD) | T1-BE #14 (`packages/types/src/auth.test.ts`) |
| Email-bound invites force `max_uses = 1` | T1-BE #14 (`invites/adminRoutes.ts`) |
| ADR 0001: unverified members get 403 on directory/tree/PII (decision recorded, tests) | T1/T5/T6, ADR 0001 |
| `Referrer-Policy: no-referrer` (API) and dev Origin allowlist (`DEV_ALLOWED_ORIGINS`) | WP-0.4 #8, T1-BE #14 |
| T1-BE: `POST /api/auth/logout-all`; wrong current password = 400 `VALIDATION` on `currentPassword`; `/auth/logout` 401 when the session is already dead; verify-request rate limit | T1-BE #14 |
| T2: one `computeCountdown` (`shared/lib/dates.ts`); same-Cuencada itinerary location check; draft-only delete guard (never published, no media); legacy `data/cuencada2026.ts` + server `data.ts` deleted | T2-FE #11, T2-BE #12/#21 |
| T2-BE: seed `first_published_at` test | T2-BE follow-up #21 |
| T3: `hotel_location_id` must be a hotel of the same Cuencada (tests) | T3-BE #15 |
| T3-BE follow-up: unlisted attendees shown as "Familiar" (merged before T5 exposed the toggle) | #19 before #22 |
| T4: QuickTime magic bytes; `MEDIA_REQUIRE_APPROVAL` config | T4-BE #13 |
| T5-BE: avatar `limitInputPixels` | T5-BE #20 |
| T6: `parent_of` cycle check under a transaction advisory lock | T6-BE #16 |
| WP-2.1 (0002): same-Cuencada composite FKs, directory opt-out, tags, `first_published_at` | WP-2.1 #17 |
| `itineraryTagSchema` rejects bidi/invisible chars, case-insensitive dedupe | T2-BE follow-up #21 |
| T8-BE: admin disable burns pending email tokens and closes chat sockets; admin alerts independent of the global cap | T8-BE #24, #27 |
| Service worker never caches private `/api/**`: only the PII-free public edition endpoints (NetworkFirst), purged on logout; CI `check:sw` | T9 #29 |
| API CSP `connect-src` includes the `wss://` origin | WP-0.4 #8 / T7-BE #25 |
| WP-0.8b: unlisted people get `userId`/`avatarUrl` null in the family tree; avatar 24 MP cap, decode once, semaphore, `profile.*` audit actions; ≤ 3 role/status changes per target per hour, force-reset exemption only on a real flip, `?emailVerified=` filter, exclusive audit `to`; chat `senderUserId` + `room_preview` frame, 60 s revoked-session memory, deterministic tests; `hasMedia` owned by media; tags-bound comment; per-edition HMAC for hidden attendees; login/reset timing equalized | WP-0.8b #30 |
| WP-0.8a: logging query-param **allowlist** (q, search, city, familyBranch, cursor, ticket… redacted) | WP-0.8a |
| WP-0.8a: distinct 403 `EMAIL_UNVERIFIED` (server); web accepts both codes in 0.8c | WP-0.8a (+0.8c) |
| WP-0.8a: `drizzle.config.ts` refuses `push`/`drop` unless `ALLOW_DRIZZLE_PUSH=1` + loopback; AGENTS.md "never drizzle-kit push"; no `db:push` script | WP-0.8a |
| WP-0.8a: AGENTS.md rules (fictional fixtures, no PII in Error messages, explicit git paths, WP-prefixed scratch files, merge main + full suite before merge) | WP-0.8a |
| WP-0.8a: privacy sweep forward (wireframes, StyleGuide, test helpers, server/types tests outside `features/**`); StyleGuide uses generated placeholder photos and a placeholder WhatsApp link | WP-0.8a |
| WP-0.8a: Vitest 4.1.11 (tinypool/vitest advisories), esbuild override for drizzle-kit; full `pnpm audit` clean | WP-0.8a |
| WP-0.8a: flaky tests: web `testTimeout` 15 s / `hookTimeout` 30 s, `maxWorkers` 50 %, admin "two admins demote each other" (root cause: the legitimate 401 interleaving, now accepted; 3 rounds / 60 s), `warmRoutes()` for lazy pages (CuencadaYearPage) | WP-0.8a |
| WP-2.3: route inventory drift guard, authorization matrix (99 routes × 7 principals, 27 state-checked IDOR/rule/mass-assignment probes, CSRF, WS), PII leak scans (bodies and WS frames), header/CSP tests, threat model, OWASP/ASVS checklist, dependency review, SPA CSP verified in Chromium (incl. the resize worker); M1 `Cache-Control: no-store` on every `/api/` response; **M2 (owner decision) gallery, media routes and member edition links need a verified email**; L6 stored photo/avatar cache ≤ 1 h | WP-2.3 (`docs/security/`, PR #35) |
| WP-0.8a: Toast never evicts an action toast, clears evicted timers; Badge `max` ("999+"); BottomNav "Programa" fits at 320 px | WP-0.8a |
| WP-0.8a: emails Container `width="600"`, Button no-VML JSDoc, LICENSE title + repo URL, test script `--config` | WP-0.8a |
| WP-2.2: Playwright e2e (iPhone 13 / Pixel 7 / desktop subset), mobile gates (overflow, 44 px targets, 16 px inputs, axe), Lighthouse mobile, CI `e2e.yml` | WP-2.2 |
| WP-2.2 bug: invite page stuck on "Revisando tu invitación…" when the boot refresh 401 aborted the inspect (waits for the session gate now) | WP-2.2 |
| WP-2.2 bug: chat message log not keyboard-focusable (axe `scrollable-region-focusable`) | WP-2.2 |

## Open

### Backend (open after WP-0.8b #30)
- T4: a `pending_upload` row with a null `upload_expires_at` is never considered stale (cleanup filters `isNotNull`); decide and test. `X-Content-Type-Options: nosniff` on stored QuickTime objects (S3 metadata).
- T4: neutralize non-A/V tracks (GoPro gpmd, Google camm, mebx, subtitle GPS): zero samples, convert `trak` to `free`; tests. Interim: upload help text about action cams/drones.
- T6: concurrent test for the `parent_of` cycle check (two inverse edges at once).
- T5: store phones as E.164 server-side (10-digit numbers are assumed +52 today).
- T8-BE (optional): coalesce admin alerts per target per 10 min. Nits: summary SQL via ORM table refs; comment on the unreachable 409; comment on target filtering.
- T7-BE: ping re-checks session + user status.
- `lib/storage`: `getStream`/`putStream` (video jobs buffer up to 300 MB, ~600 MB peak). Until then consider a 150 MB video cap.
- Media: `incoming/` prefix + server-side copy on confirm, so a bucket lifecycle rule can expire orphans (with WP-2.1/2.4).
- Optional: `audit_logs.action` format CHECK (with a migration, WP-2.x).

### 0.8c (web features)
- Centralize the "verify your email" handling on 403 `EMAIL_UNVERIFIED`. WP-0.8a already made the directory (`AccessStates.tsx`) and family tree (`FamilyTreePage.tsx`) accept it alongside `FORBIDDEN`; chat and RSVP branch on the 403 status. Then drop the `FORBIDDEN` fallbacks and update fixtures.
- T1-FE: switch "cerrar en todos" to `logout-all`; on a second `REFRESH_RACE` wait past the grace (~10 s) and retry once; "vuelve a pedirlo" copy for lost emails.
- T2-FE: `useScrollToHash` try/catch on a malformed fragment; Home daily message refreshes past midnight (`useNow` tick); admin Mensajes Select label truncation at 375 px; forecast URL format hint (`www.` rejected); record the section-order decision; R2 tips/extras content model; R1 itinerary tags; R4 song lyrics URL; R8 admin-picked highlights (needs T4).
- T3-FE: hotel re-save while members load; deadline lock re-evaluates at midnight; R2 attendance link from the T2 edit page + T8 shell.
- T4-FE: switch `/galeria` probing to `CuencadaSummary.hasMedia`; Vite `envDir` (root `.env`) or `apps/web/.env.local` docs + dev bucket example; check `VITE_MEDIA_UPLOAD_ORIGIN` before the intent (disabled button + Spanish copy + dev hint) to avoid orphan rows.
- T5-FE: directory cursor 400 after self-unlist → reload page 1; show the number on the WhatsApp button; city filter prefix match/suggestions; cancel avatar confirm on unmount; "Aparecer en el directorio" help text says chat messages still show your name/photo.
- T6-FE (L1): breadcrumb history state keeps ids only (names from the cache) or is tagged with the userId.
- T8-FE: `createInvite` with `track: false`; shorten entity ids on mobile; clipboard warning copy; audit viewer shows `adminAlertSkipped`/limit flags; move T2/T4/T6 admin pages under the admin layout (cross-track).
- Privacy sweep inside `features/**` (WP-0.8a swept everything else): fictional people only. First: "Jorge Cuenca", "Lupe Cuenca", "Rosa Cuenca" in `features/auth/**` tests and `contractHandlers.ts`.
- **Real family photos are members-only (owner decision, PR #31).** `apps/web/public/images/fotos/` is gone: replace the public HomePage "Últimos momentos" mosaic with a non-identifying image + "Inicia sesión para ver las fotos" teaser; members see recent photos from the private gallery (presigned URLs). Until then the mosaic images 404.
- Re-take with placeholder images the screenshots WP-0.8a deleted: `t2/home-memories-{375,1280}`, `t4/{grid,lightbox,upload-sheet,upload-progress,admin-queue}-{375,1280}`, `t9/offline-home-375` (WP-0.7's `styleguide-*`, `overlays-375`, `lightbox-1280`: orchestrator).
- Adopt `warmRoutes()` (`apps/web/test/renderApp.tsx`) in other route-level tests whose first test flakes (admin.test.tsx, GalleryPage.test.tsx were seen failing once under load).

### 0.8c: chat (T7-FE follow-ups after PR #28)
- `RoomList` badge: `<Badge shape="count" max={999}>` (WP-0.8a added `max`).
- Chat fixtures/handlers answer `FORBIDDEN` for unverified members; the server now answers `EMAIL_UNVERIFIED` (`socket.ts` already branches on the 403 status).
- `features/chat/testing/fixtures.ts` `ME` is "Prima Cuenca": rename to a fictional person and retake the `docs/ux/screenshots/t7/` screenshots if the name shows.
- Preview update after delete.

### WP-2.2 findings (e2e + gates)
- T9 / UX: offline, the year page hero shows a broken-image glyph. `/images/Logo_Cuencada2026.jpg` (the 2026 `heroImageUrl`) is neither precached nor runtime-cached. Either add a CacheFirst runtime route for same-origin `/images/**` (size-capped, no user data) or hide the hero `<img>` on `error` (see `docs/ux/screenshots/e2e/10-offline-programa-375.webp`).
- WP-0.6 / UX: the top `OFFLINE_NOTICE` banner ("Sin conexión. Reintentaremos…") renders edge to edge with no side padding at 375 px (same screenshot). One combined offline banner is still T9 Request 5.
- WP-0.7 / UX (WCAG 2.2 2.4.11 Focus Not Obscured): the sticky header and the bottom tab bar can cover a control that the browser scrolls into view (Playwright's scroll-into-view put the RSVP radio under the tab bar and the directory switch under the header). Add `scroll-padding-top`/`scroll-padding-bottom` on `html` matching the bar heights.
- T5/T6-FE copy: the profile hint for "Rama familiar" says "Por ejemplo: Rama Norte.", but the tree renders `Rama ${familyBranch}` and the profile header `Rama: ${familyBranch}`, so following the hint shows "Rama Rama Norte". Either change the hint to "Por ejemplo: Norte." or stop prefixing. (The e2e fixtures now use "Norte".)
- Ops (unconfirmed): under parallel e2e load, a caption `PATCH` once took about 13 s while sharp jobs and argon2 logins ran. Both use the libuv threadpool (default 4). Measure in staging; consider `UV_THREADPOOL_SIZE` and/or a sharp concurrency limit in the systemd unit.
- CI: add a WebKit project for the iPhone profile once the runner installs WebKit dependencies (journeys run in Chromium today; service-worker checks may need to stay Chromium-only). Decide whether `e2e.yml` is a required check and whether Lighthouse should block.

### WP-2.x
- WP-2.1 nits: fix the NOT VALID locking comment; schema comments point to the WP-2.1.md hand-written SQL section.
- Next contract-phase migration (0003): drop redundant single-column location FKs; optional `first_published_at` refine from audit.
- Migrations from 0002 on must be expand/contract (run before new code is live).
- **Minimum client version mechanism** (force-reload/upgrade prompt for stale PWA clients after a breaking API change, e.g. the `EMAIL_UNVERIFIED` split).
- Observability: alert on `mail.cap_reached` and `mail.queue_full` (Loki/Grafana).
- Process: lint/review rule for "no PII interpolated into Error messages" (Security L7, PR #8). AGENTS.md states the rule; an automated check is still open.
- T8-BE (from WP-0.8c): `GET /admin/users/:id`, so T6-FE's admin person form can show the linked account exactly (today it searches `GET /admin/users?q=<person name>`, which misses accounts whose display name differs).
- T5-BE (from WP-0.8c): store phones as E.164 (or a country code) so the directory can offer WhatsApp for numbers typed without `+`; the web never guesses `+52`.

### WP-2.3 findings

Source: the security audit in [`docs/security/`](../security/README.md).
Fixed in WP-2.3 (PR #35):

- M1: `/api/` responses send `Cache-Control: no-store`.
- M2, formerly L2 (owner decision): `requireVerifiedEmail` on every media
  route and on `/cuencadas/:year/members`. Announcements and the RSVP summary
  stay open to unverified members.
- L6: stored photos and avatars are cached privately for at most 1 h.
- M2 web follow-up: `/cuencada/:year` shows the verify-email prompt (or the
  no-access copy) instead of a dead "Reintentar" when `/members` answers 403.
  `/galeria` hides the upload button and the upload panel over the 403.
  Screenshot: `docs/ux/screenshots/t2/cuencada-2026-unverified-375.webp`.

Still open:

- **Open invites (separate WP, planned mitigation for threat-model A2):**
  - Today a leaked open invite lets a stranger create an account and verify
    their **own** mailbox, which unlocks every member-only area.
  - Tighten the defaults to about 5 uses and a 72 h lifetime.
  - Send an admin alert on each acceptance.
- **L1 (0.8c, web):** zod 4 probes `new Function("")` once per page load.
  CSP blocks it, so the app works, but it emits a `securitypolicyviolation`
  (and a report, once a `report-to` endpoint exists).
  - Fix: call `z.config({ jitless: true })` in `apps/web/src/main.tsx` before
    any schema runs.
  - Then remove the `isKnownZodEvalProbe` allowance from
    `docs/security/csp-check.mjs`.
- **L3 (WP-2.4):** `contentSecurityPolicy(config)` in
  `apps/server/src/plugins/security.ts` renders `base-uri 'self'` and
  `frame-src 'self' https://weatherwidget.io`. That is looser than the SPA
  policy in `docs/security/csp.md`. Paste the `csp.md` string verbatim (see
  the cutover checklist). Don't generate the header from the function unless
  it is aligned first.
- **L4 (platform):** the CI `services.postgres.image` is `postgres:16-alpine`,
  pinned by tag. Actions are SHA-pinned; pin this image by digest too.
- **L5 (backend, pre-launch):** there is no breached-password check (ASVS
  2.1.7) on password set, change or reset.
  - Option 1: an offline list of the top 100k passwords, shipped with the
    server.
  - Option 2: HIBP range queries (k-anonymity) with a timeout that fails open.
  - It is on the pre-launch list in the cutover checklist.

## Cutover checklist (WP-2.4–2.5)

- [ ] Reset the WhatsApp group invite link and the OneDrive share links (public in the legacy `index.html` and git history; the dev fallbacks live only in `apps/server/src/seed-data.ts` `LEGACY_DEV_LINKS`). Set the new values only via vault `SEED_*_URL` or the admin UI.
- [ ] Set **all** `SEED_*_URL` vars on the **first** prod seed (links only reach the edition row on first insert).
- [ ] Prod seed: run once, manually, over the tunnel (user-approved), after migrations.
- [ ] Separate DB roles: owner for `MIGRATE_DATABASE_URL`, least-privilege runtime `DATABASE_URL`.
- [ ] Recreate any local dev DB that applied the pre-review 0001.
- [ ] Not behind Cloudflare: nginx sets `X-Forwarded-For $remote_addr` (overwrite) and ignores `CF-Connecting-IP`; TLS terminates on the VPS (verify cert + HSTS); rate limits rely on the direct IP.
- [ ] **Paste the `Content-Security-Policy` string from [`docs/security/csp.md`](../security/csp.md) verbatim** into nginx. Don't render it from `contentSecurityPolicy(config)`, which is looser (WP-2.3 L3).
- [ ] nginx CSP and headers for the SPA, exactly as in [`docs/security/csp.md`](../security/csp.md). That covers the weather widget frame, the bucket host only, `wss:`, `base-uri 'none'`, HSTS, nosniff, DENY, `Referrer-Policy`, `Permissions-Policy`, and `always` on every `add_header`. Then re-run `node docs/security/csp-check.mjs` against staging and repeat the OWASP sign-off.
- [ ] nginx access logs redact `?q=`, `?search=`, `?ticket=` (and ideally mirror the API allowlist in `apps/server/src/logging.ts`).
- [ ] `VITE_MEDIA_UPLOAD_ORIGIN=https://<bucket>.us-southeast-1.linodeobjects.com` in infra `build_env` for every environment (uploads are refused if unset); T5 avatar uploads apply the same origin check.
- [ ] Real-bucket check that a PUT with the wrong length/type is rejected; bucket CORS XML from `WP-T4-BE.md`.
- [ ] Confirm `server_1` has ≥ 700 MB free for the API; systemd `MemoryHigh`/`MemoryMax` + restart alert, else drop the video limit to 150 MB in the contract.
- [ ] Retire the legacy root site (`index.html`, `cuencada2026.html`) and its `images/fotos` at cutover; the owner decides whether to purge them from git history.
- [ ] **Pre-launch:** breached-password check on password set, change and reset (WP-2.3 L5, ASVS 2.1.7).
- [ ] **Pre-launch:** stricter open invites: about 5 uses, 72 h lifetime, an admin alert on each acceptance (separate WP; threat model A2).
- [ ] Git history still contains the pre-sweep real/real-looking family names and the legacy links; owner decided "sweep forward, no history rewrite". Revisit only if the owner asks.
