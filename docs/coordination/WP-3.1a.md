# WP-3.1a Undated ("announced") editions
Owner: Senior full-stack JS engineer (Architect hat) · Reviewers: Architect, TL · Branch: wp/3.1a-undated-editions · PR: # (not opened)

Based on `origin/main` (8a41310, PR #39 merged).

## Problem
Cuencada 2026 is over. The next one is 2027, but its place, month and day are not decided. `starts_at`/`ends_at`/`city`/`state` were NOT NULL, so an admin had to type placeholder dates, and Home would count down to a fake date. A countdown must only show for a published edition with real dates.

## Scope
- **Migration `0003_undated_editions`** (expand-only; this WP is the schema owner for 0003): `cuencadas.starts_at`, `ends_at`, `city`, `state` become nullable. `cuencadas_dates_check` becomes `(starts_at IS NULL AND ends_at IS NULL) OR (starts_at IS NOT NULL AND ends_at IS NOT NULL AND ends_at > starts_at)`, added `NOT VALID` then validated in the same transaction. Drizzle schema and `meta/0003_snapshot.json` match; `drizzle-kit generate` reports "No schema changes".
  - Audit of everything else that assumed dates: `year` is its own NOT NULL column with its own CHECK and unique index (not derived from `starts_at`). `cuencadas_published_starts_at_idx` is a plain btree and indexes NULLs. No FK, CHECK or index ties `rsvp_deadline` to the dates, and no other table references the four columns. Nothing else changed.
  - Why it is expand-only: 0002-era code keeps working on a 0003 database, because only the new code ever writes a NULL date or place. Existing rows are untouched.
- **Contracts** (`packages/types`):
  - `CuencadaStatus.Announced = "announced"` and `HomeMode.Announced = "announced"`.
  - `CuencadaSummary`, `PublicCuencada` and `AdminCuencada`: `startsAt`/`endsAt`/`city`/`state` are `string | null`.
  - Create input: the four fields may be omitted (default `null`). `city`/`state` use `nullableTextSchema` (blank → `null`). Both-or-neither refine (`CUENCADA_DATES_TOGETHER_MESSAGE`, on `endsAt`). PATCH: both `null` clears the dates; a lone `null` is refused; a lone date may move one end of an already dated edition (the server checks the merged row).
  - `DatedCuencada<T>` and the `hasDates()` type guard.
  - `rsvp.ts`: `RsvpIssueCode.DatesPending = "RSVP_DATES_PENDING"` and `RSVP_DATES_PENDING_MESSAGE` ("Las confirmaciones abren cuando se anuncie la fecha.").
- **Server:**
  - `status.ts`: `computeCuencadaStatus` returns `announced` for a published edition without dates. `selectHome(editions, now)` orders: active (earliest start), then the soonest dated upcoming one, then the announced one with the lowest year ≥ the current year **in that edition's timezone** (`localYearInZone`), then memories. `latestPast` is always the most recently ended past edition.
  - Mappers send `null` dates. The admin PATCH re-validates the merged dates (both-or-neither and order) with a Spanish 400 on `endsAt` instead of a 500 from the CHECK.
  - RSVP: `rsvpEditability` returns `dates_pending` for an announced edition, **before** the deadline check (a future deadline without dates does not open RSVPs: there is no stay window). `PUT …/rsvp/me` answers 409 `CONFLICT` with the message above and `details: [{ path: "cuencada", message, code: "RSVP_DATES_PENDING" }]`. `GET …/rsvp/me` answers `editable: false`. `rsvpDateWindow` now only accepts non-null dates (the route narrows explicitly). Attendees and the RSVP summary are unchanged and work for announced editions.
  - Seed: 2026 is unchanged and no 2027 is seeded. `seed.ts` only maps nullable dates (`toDateOrNull`).
  - Test helper `insertAnnouncedCuencada(year, overrides)` in `test/helpers/cuencadas.ts`.
- **Web:**
  - Home: `FeaturedHero` picks `UpcomingHero` (typed `DatedCuencada<PublicCuencada>`, so a countdown can't get `null`) or the new `AnnouncedHero`. That hero shows the kicker "La próxima Cuencada", the title "Cuencada {year}", the note "Fecha y lugar por anunciar" (or "{Ciudad}, {Estado} · Fecha por anunciar"), the buttons "Ver Cuencada {year}" and "Ver recuerdos de {latestPast}", and the RSVP slot. There is no countdown. The "Últimos momentos" photos section of the previous edition stays; the memories-mode "La próxima Cuencada / Todavía no tiene fecha" card does not. The "Todo en un solo lugar" section (`Highlights`) and `AppLayout`/`MorePage` were **not** touched (WP-3.1b owns them).
  - Year page: the kicker reads "Fecha y lugar por anunciar" / "Lugar por anunciar · …" / "… · Fecha por anunciar". `PendingFacts` ("Fechas: / Lugar: Por anunciar") replaces the countdown. For an undated edition, empty programa and lugares sections are hidden (along with their hero buttons and section-nav links) and reappear once they have items. The weather section is hidden while there is no city.
  - RSVP card: an edition without dates shows the note instead of the form and never calls `rsvp/me`. `RsvpPanel`/`RsvpBody` take `DatedCuencada<PublicCuencada>`.
  - Admin form: Ciudad, Estado, Inicio and Fin are optional, with the hint "Déjalo vacío si aún no se define". Both-or-neither is checked in the form, with the error on the empty date. The admin list shows "Lugar por anunciar" / "Fecha por anunciar". The edit page gives a new itinerary item an empty default date when the edition has none.
  - Null-safe date sorts: `galleryYearsFrom` skips undated editions when looking for a started one. The admin and edition lists sort by `year`. `PastEditions` / `MemoriesHero` tolerate a `null` city. The PWA cache rules are path-based and unaffected. Chat rooms per edition are keyed by id and unaffected. The admin dashboard's next edition (`AdminSummaryEdition.startsAt: string`) still lists dated editions only (`ends_at > now` is NULL for undated rows): an announced edition has no RSVPs to count.
  - `lib/format.ts`: `formatKicker` accepts null fields; new `formatPlace`, `formatEditionDates`, `TO_BE_ANNOUNCED`, `DATE_AND_PLACE_TO_BE_ANNOUNCED`. `countdownInstants`/`formatDateRange`/`computeCountdown` keep `string`-only parameters.
  - Fixtures: `makeAnnouncedCuencada`, `makeAnnouncedHome`, `CUENCADA_2027_ID` (fictional data).
- **E2E:** the harness keeps the dated future 2027 and adds an announced **2028** (`ANNOUNCED_YEAR`, published, no dates, no place, no chat room). It never becomes Home's featured edition while 2027 is upcoming. New journey: "4 · an announced edition shows Por anunciar, no countdown and no RSVP form" (anonymous, then Ana sees the RSVP note).
- **Security matrix:** no route guard changed. `routeMatrix.ts` and `docs/security/routes.md` are untouched.
- **Docs:** ADR 0001 §5 (note on `announced`). Screenshots in `docs/ux/screenshots/t2/`: `home-announced-{375,1280}.webp` and `year-2027-announced-{375,1280}.webp`. They were taken with headless Chromium against `vite preview`, with `/api/**` stubbed from `testing/fixtures.ts` (visitor view, device timezone Europe/Madrid).

## Decisions
- **Year rollover per edition timezone.** An announced edition stays featured through 31 December in its own timezone. After that it is stale and ignored, so Home falls back to memories instead of advertising a year that is already over.
- **No new top-level `ErrorCode`.** `errorCodeSchema` is a closed enum that older clients validate, so a new value would break their parsing. The stable reason travels as a detail code (the open channel from WP-2.3c).
- **A place without dates (or dates without a place) is allowed.** Only the dates are tied together.
- **`HomeMode.Announced`** rather than reusing `upcoming`: the web must not mistake an undated edition for one with a countdown, and the type guard enforces it at compile time.
- **Hide empty sections only for undated editions.** A dated edition keeps its existing "pronto publicaremos…" empty states, so nothing changes for 2026-style pages.

## Open questions (→ orchestrator)
- The `AppLayout` "Programa" destination uses `featured.year`. In announced mode it now opens `/cuencada/2027`, which shows "Por anunciar" and no programa. WP-3.1b owns the nav: it may want to fall back to `latestPast` when `home.mode === "announced"`.

## Verification (2026-10-07)
- `pnpm lint`, `pnpm turbo run typecheck --force` (6/6), `pnpm test` (160 files, 2036 tests) and `pnpm build` (4/4): all green, both before and after `git merge origin/main` (main had not moved: 8a41310).
- `drizzle-kit generate`: "No schema changes, nothing to migrate".
- The migration test "migration 0003" runs 0000 → 0002, inserts rows in the 0002 shape (and checks that 0002 refuses an undated edition), then migrates to latest. It asserts:
  - the `cuencadas` rows are identical before and after, and the RSVP is kept;
  - an undated, placeless published insert works, and so does a place without dates;
  - one date alone is rejected (23514) on insert (either column) and on update (clearing one, setting one);
  - order is still enforced when both dates are set; setting and then clearing both works;
  - `year` is still NOT NULL and unique.
  - The 0002 test now compares against the journal length instead of a hard-coded count.
- Unit tests for every `selectHome` branch: active > upcoming > announced > memories; the lowest announced year; a stale announced year; the 31 Dec → 1 Jan rollover in Mérida (05:59:59Z vs 06:00Z); a per-edition timezone (Tokyo vs Mérida at 2026-12-31T15:00Z); drafts and an empty list. Plus `computeCuencadaStatus`/`localYearInZone` for undated editions and `rsvpEditability` `dates_pending`.
- Route tests: public `GET /cuencadas`, `/:year` and `/home` (announced mode, dated upcoming wins); admin create/publish announced, one-date 400, PATCH set → clear dates; RSVP 409 `RSVP_DATES_PENDING` with no row written, `rsvp/me` `editable: false`, attendees and summary for an announced edition; the admin summary ignores undated editions.
- Web tests: Home announced (no `timer`, links, place variant), year page announced (Por anunciar, hidden sections and nav, no weather without a city; the programa reappears with items), RSVP note without calling `rsvp/me`, admin form (hint, both-or-neither error, null body), `formatKicker`/`formatPlace`/`formatEditionDates`, `galleryYearsFrom`.
- E2E (`pnpm e2e:build` + `playwright test --project=iphone-13 --project=desktop-1280 --project=mobile-gates`, isolated ports 3290/3291/4290 and DB `cuencada_w31a_e2e`): 27 passed, including the new announced journey on iphone-13 and the quality gates.

## Review log
