# Backlog

Deferred and cross-track work, grouped by status. Imported from the
orchestrator's working backlog by WP-0.8a (2026-10-06) and checked against
`main` after PRs #1–#28. Add new items here instead of leaving TODOs in code.
When an item ships, move it to **Done** with the PR number.

Owners: **0.8a** platform & repo hygiene · **0.8b** backend modules (auth,
family, profile, admin, chat, media, cuencadas) · **0.8c** web features
(`apps/web/src/features/**`) · **T9** PWA ·
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
| API CSP `connect-src` includes the `wss://` origin | WP-0.4 #8 / T7-BE #25 |
| WP-0.8a: logging query-param **allowlist** (q, search, city, familyBranch, cursor, ticket… redacted) | WP-0.8a |
| WP-0.8a: distinct 403 `EMAIL_UNVERIFIED` (server); web accepts both codes in 0.8c | WP-0.8a (+0.8c) |
| WP-0.8a: `drizzle.config.ts` refuses `push`/`drop` unless `ALLOW_DRIZZLE_PUSH=1` + loopback; AGENTS.md "never drizzle-kit push"; no `db:push` script | WP-0.8a |
| WP-0.8a: AGENTS.md rules (fictional fixtures, no PII in Error messages, explicit git paths, WP-prefixed scratch files, merge main + full suite before merge) | WP-0.8a |
| WP-0.8a: privacy sweep forward (wireframes, StyleGuide, test helpers, server/types tests outside `features/**`); StyleGuide uses generated placeholder photos and a placeholder WhatsApp link | WP-0.8a |
| WP-0.8a: Vitest 4.1.11 (tinypool/vitest advisories), esbuild override for drizzle-kit; full `pnpm audit` clean | WP-0.8a |
| WP-0.8a: flaky tests: web `testTimeout` 15 s / `hookTimeout` 30 s, `maxWorkers` 50 %, admin "two admins demote each other" 3 rounds / 60 s, `warmRoutes()` for lazy pages (CuencadaYearPage) | WP-0.8a |
| WP-0.8a: Toast never evicts an action toast, clears evicted timers; Badge `max` ("999+"); BottomNav "Programa" fits at 320 px | WP-0.8a |
| WP-0.8a: emails Container `width="600"`, Button no-VML JSDoc, LICENSE title + repo URL, test script `--config` | WP-0.8a |

## Open

### 0.8b (backend modules)
- T4: a `pending_upload` row with a null `upload_expires_at` is never considered stale (cleanup filters `isNotNull`); decide and test. `X-Content-Type-Options: nosniff` on stored QuickTime objects (S3 metadata).
- T4: neutralize non-A/V tracks (GoPro gpmd, Google camm, mebx, subtitle GPS): zero samples, convert `trak` to `free`; tests. Interim: upload help text about action cams/drones.
- T6: concurrent test for the `parent_of` cycle check (two inverse edges at once).
- T6-BE (Security L2 #19): for unlisted users, family tree/detail/search return `userId: null` and `avatarUrl: null` to others (name kept, genealogy intact).
- T5-BE: avatar decode once + small semaphore; add `profile.*` to `AuditAction`.
- T5: store phones as E.164 server-side (10-digit numbers are assumed +52 today).
- T8-BE: limit role/status changes on the same target to 3/hour (caps the exempt-alert flood); optionally coalesce alerts per target per 10 min. Force-reset exempt only when `must_change_password` flips false→true. Nits: summary SQL via ORM table refs; comment on the unreachable 409; comment on target filtering.
- T8-BE: unverified-email filter on the users list (T8-FE request); audit "hasta" exclusive upper bound server-side.
- T7-BE: poll instead of sleep in the slow-reader test; test the post-registration DB recheck; keep user sessions in a 60 s memory; ping re-checks session + user status. T7-FE requests: `senderUserId` on `ChatRoomLastMessage`.
- T3-BE (optional): mix the edition id into the HMAC ordering.
- T2-BE: comment on the x4 raw array bound.
- Reconcile `hasMedia`: T2-BE `EXISTS` vs T4 `countVisibleMediaByCuencada` (same rule: ready + approved + not deleted).
- `lib/storage`: `getStream`/`putStream` (video jobs buffer up to 300 MB, ~600 MB peak). Until then consider a 150 MB video cap.
- Media: `incoming/` prefix + server-side copy on confirm, so a bucket lifecycle rule can expire orphans (with WP-2.1/2.4).
- T1 L2 (optional): move budget + token creation into the mail job (timing).
- Optional: `audit_logs.action` format CHECK (with a migration, WP-2.x).

### 0.8c (web features)
- Accept 403 `EMAIL_UNVERIFIED` as well as `FORBIDDEN` for "verify your email" (WP-0.8a changed the server code).
- T1-FE: switch "cerrar en todos" to `logout-all`; on a second `REFRESH_RACE` wait past the grace (~10 s) and retry once; "vuelve a pedirlo" copy for lost emails.
- T2-FE: `useScrollToHash` try/catch on a malformed fragment; Home daily message refreshes past midnight (`useNow` tick); admin Mensajes Select label truncation at 375 px; forecast URL format hint (`www.` rejected); record the section-order decision; R2 tips/extras content model; R1 itinerary tags; R4 song lyrics URL; R8 admin-picked highlights (needs T4).
- T3-FE: hotel re-save while members load; deadline lock re-evaluates at midnight; R2 attendance link from the T2 edit page + T8 shell.
- T4-FE: switch `/galeria` probing to `CuencadaSummary.hasMedia`; Vite `envDir` (root `.env`) or `apps/web/.env.local` docs + dev bucket example; check `VITE_MEDIA_UPLOAD_ORIGIN` before the intent (disabled button + Spanish copy + dev hint) to avoid orphan rows.
- T5-FE: directory cursor 400 after self-unlist → reload page 1; show the number on the WhatsApp button; city filter prefix match/suggestions; cancel avatar confirm on unmount; "Aparecer en el directorio" help text says chat messages still show your name/photo.
- T6-FE (L1): breadcrumb history state keeps ids only (names from the cache) or is tagged with the userId.
- T8-FE: `createInvite` with `track: false`; shorten entity ids on mobile; clipboard warning copy; audit viewer shows `adminAlertSkipped`/limit flags; move T2/T4/T6 admin pages under the admin layout (cross-track).
- Privacy sweep inside `features/**` (WP-0.8a swept everything else): fictional people only.
- Adopt `warmRoutes()` (`apps/web/test/renderApp.tsx`) in other route-level tests whose first test flakes (admin.test.tsx, GalleryPage.test.tsx were seen failing once under load).

### 0.8c: chat (T7-FE follow-ups after PR #28)
- `RoomList` badge: `<Badge shape="count" max={999}>` (WP-0.8a added `max`).
- Chat fixtures/handlers answer `FORBIDDEN` for unverified members; the server now answers `EMAIL_UNVERIFIED` (`socket.ts` already branches on the 403 status).
- `features/chat/testing/fixtures.ts` `ME` is "Prima Cuenca": rename to a fictional person and retake the `docs/ux/screenshots/t7/` screenshots if the name shows.
- Preview update after delete.

### T9 (PWA)
- The service worker must never cache `/api/**` responses.

### WP-2.x
- WP-2.1 nits: fix the NOT VALID locking comment; schema comments point to the WP-2.1.md hand-written SQL section.
- Next contract-phase migration (0003): drop redundant single-column location FKs; optional `first_published_at` refine from audit.
- Migrations from 0002 on must be expand/contract (run before new code is live).
- **Minimum client version mechanism** (force-reload/upgrade prompt for stale PWA clients after a breaking API change, e.g. the `EMAIL_UNVERIFIED` split).
- Observability: alert on `mail.cap_reached` and `mail.queue_full` (Loki/Grafana).
- Process: lint/review rule for "no PII interpolated into Error messages" (Security L7, PR #8). AGENTS.md states the rule; an automated check is still open.

## Cutover checklist (WP-2.4–2.5)

- [ ] Reset the WhatsApp group invite link and the OneDrive share links (public in the legacy `index.html` and git history; the dev fallbacks live only in `apps/server/src/seed-data.ts` `LEGACY_DEV_LINKS`). Set the new values only via vault `SEED_*_URL` or the admin UI.
- [ ] Set **all** `SEED_*_URL` vars on the **first** prod seed (links only reach the edition row on first insert).
- [ ] Prod seed: run once, manually, over the tunnel (user-approved), after migrations.
- [ ] Separate DB roles: owner for `MIGRATE_DATABASE_URL`, least-privilege runtime `DATABASE_URL`.
- [ ] Recreate any local dev DB that applied the pre-review 0001.
- [ ] Not behind Cloudflare: nginx sets `X-Forwarded-For $remote_addr` (overwrite) and ignores `CF-Connecting-IP`; TLS terminates on the VPS (verify cert + HSTS); rate limits rely on the direct IP.
- [ ] nginx CSP for the SPA (weatherwidget, S3 origin, `wss:`), `Referrer-Policy`.
- [ ] nginx access logs redact `?q=`, `?search=`, `?ticket=` (and ideally mirror the API allowlist in `apps/server/src/logging.ts`).
- [ ] `VITE_MEDIA_UPLOAD_ORIGIN=https://<bucket>.us-southeast-1.linodeobjects.com` in infra `build_env` for every environment (uploads are refused if unset); T5 avatar uploads apply the same origin check.
- [ ] Real-bucket check that a PUT with the wrong length/type is rejected; bucket CORS XML from `WP-T4-BE.md`.
- [ ] Confirm `server_1` has ≥ 700 MB free for the API; systemd `MemoryHigh`/`MemoryMax` + restart alert, else drop the video limit to 150 MB in the contract.
- [ ] Git history still contains the pre-sweep real/real-looking family names and the legacy links; owner decided "sweep forward, no history rewrite". Revisit only if the owner asks.
