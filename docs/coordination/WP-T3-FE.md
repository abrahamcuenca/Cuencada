# WP-T3-FE RSVP & attendance (web)
Owner: Frontend · Reviewers: TL, Sec · Branch: wp/t3-fe-rsvp · PR: # (not opened)

## Scope
- **API** (`features/rsvp/api.ts`, injected into the frozen `baseApi`, tags `Rsvp`, `RsvpSummary`, `Attendee`, `Attendance`, `Person`):
  - `getMyRsvp(year)` → `GET /cuencadas/:year/rsvp/me`
  - `putMyRsvp({ year, body, optimistic })` → `PUT /cuencadas/:year/rsvp/me`. It patches the `getMyRsvp` cache right away, replaces it with the server's `MyRsvp` on success, and calls `undo()` on failure. A successful save invalidates the year's `RsvpSummary` and `Attendee`.
  - `getRsvpSummary(year)`, `listAttendees(year)`
  - admin: `getAdminAttendance(id)`, `saveAdminAttendance({ cuencadaId, body })` → **`PUT`** `/admin/cuencadas/:id/attendance` with T3-BE's replace-set `{ personIds }` (atomic; the result is upserted into the cache), `listAdminRsvps(id)`, `exportRsvpsCsv(id)`
  - `listAttendancePeople(query)` → `GET /family/people` (T6-BE, now on main). It has its own name so it never collides with T6-FE's endpoint.
- **CSV export [SEC]:** fetched through the normal `baseQueryWithReauth` (Bearer header and refresh, nothing in the URL) with `responseHandler: "content-type"`. T3-BE sends a BOM, but `Response.text()` strips it, so the page restores **exactly one** (never a second), wraps the text in a `text/csv` `Blob`, saves it through a temporary `a[download]` and `blob:` URL, **revokes the URL** right after (1 s, tested), then `reset()`s the mutation so the emails don't stay in the Redux store.
- **`RsvpSlot` → `RsvpCard`** (`components/RsvpCard.tsx`, `RsvpForm.tsx`):
  - Visitors (and users who must change their password): renders nothing and makes no request. The lock card is T2's.
  - Upcoming/active edition:
    - Card "Confirmar asistencia".
    - Deadline day in the edition's timezone: "Confirma a más tardar el 31 de mayo de 2027." (T3-BE keeps RSVPs open until the end of that local day, so no time is shown)
    - "¿Vas a la Cuencada {year}?" as a `fieldset` of three native radios styled as 64px segmented buttons (Sí / Tal vez / No).
    - For Sí/Tal vez:
      - a 0–20 guest stepper (44px `IconButton`s plus a numeric input)
      - arrival/departure native date inputs. `min`/`max` are the edition's days in its timezone ± `RSVP_DATE_WINDOW_DAYS` (14, from `@cuencada/types`, same rule as the server), and departure's `min` follows arrival.
      - a hotel `Select` with only the `hotel` locations from `GET /cuencadas/:year/members` (a cached request on the year page)
    - Notes (≤ 500).
    - A "No" answer hides guests, dates and hotel, and sends them as `0`/`null`.
    - Validation: Spanish pre-checks (date window, hotel list), then the contract `upsertRsvpInputSchema`. That covers "La salida debe ser igual o posterior a la llegada." Errors show on the field (`aria-invalid`).
    - Optimistic save: the summary ("✅ ¡Vas! Tú + 2 acompañantes", dates, hotel, notes) shows at once and gets focus, followed by the toast "¡Listo! Confirmaste tu asistencia." For "No" the toast is "Listo. Guardamos tu respuesta." If the save fails, the cache rolls back, the form comes back with the draft, and a danger toast shows the server message. A **409 `CONFLICT`** (closed: past edition or deadline) shows the server message and refetches `rsvp/me`, so the card locks.
    - With a saved answer, the summary has a "Cambiar respuesta" button.
    - After the deadline (`editable: false`, or the deadline's local day ended while the page was open): read-only summary plus "🔒 Las confirmaciones cerraron el … Escribe en el grupo de WhatsApp si cambiaron tus planes."
  - Past edition: a "🎉 Fuiste a esta Cuencada" badge when an attendee row has `isMe: true` (server-computed). Otherwise nothing.
  - Draft editions: nothing.
- **`AttendeesSlot` → `AttendeesCircles`:**
  - The card title is "¿Quién va?" ("¿Quién fue?" for past editions).
  - `AvatarStack` (default 5 circles + "+N", fits 320px). The label reads "12 confirmados" (T3-BE lists `yes` RSVPs plus attendance only), or "N asistentes" for past editions.
  - The whole strip is one stretched `<button aria-haspopup="dialog">`, which avoids a list inside a button. It opens a `Dialog` (a bottom sheet on phones) with every name, avatar and a "Tú" badge (`isMe`). The user comes first, then names in `es-MX` order.
  - 403: "Verifica tu correo para ver quiénes asistieron." (unverified users), or "No tienes acceso…" (verified users).
  - Empty: "Todavía nadie ha confirmado. ¡Sé el primero!" (or the past-edition variant).
  - Avatar URLs are rendered only when they are `https:` or a same-origin path.
- **Admin `/admin/cuencadas/:id/asistencia`** (`admin/`, mounted from `features/rsvp/routes.tsx` under `admin`, lazy; ranked above T2's `/admin/cuencadas/:id` and T8's `/admin/*`):
  - Header: "‹ {título}", "Asistencia" and an "Exportar CSV" button.
  - Tabs **Asistencia** / **Confirmaciones**.
  - Asistencia:
    - A search box, debounced 300 ms, which calls `GET /family/people?q=…&limit=100`.
    - A checklist: saved attendees first (they can always be removed, even when the people search fails), then the other people.
    - Toggling a box back drops the edit.
    - A sticky bar: "6 asistentes · 2 cambios sin guardar" and "Guardar asistencia". It saves the complete set as one `PUT { personIds }` (saved − removed + added, sorted) and shows the toast "Asistencia guardada."
  - Confirmaciones:
    - Totals from `rsvp/summary` (computed in SQL) and people per hotel.
    - A filter by answer (`Select`) plus a name/email search.
    - One card per answer (no tables on phones; 2 columns at ≥ 900px).
- **Edits outside `features/rsvp`:**
  - `features/cuencadas/components/slots.tsx`: only the bodies of `RsvpSlot`/`AttendeesSlot` (authorized). Names and props are unchanged.
  - T2 page tests (needed because the placeholders are gone):
    - `HomePage.test.tsx` now expects no RSVP slot for an anonymous visitor.
    - `CuencadaYearPage.test.tsx` adds an `attendees` handler (with `isMe: true`) and waits for the attended badge before checking the `data-slot`s.

## Decisions
- **Fixtures use fictional people only (public repo).** Test fixtures, the MSW fake API and the screenshot stub use invented names (e.g. "Rosa Herrera Soto", "Tomás Navarro Ruiz"), never real family names.
- **`Attendee.isMe` drives** "Fuiste a esta Cuencada", the "Tú" badge and the sort order. The earlier client-side id matching is removed (R1 done by T3-BE).
- **The card reads `GET /cuencadas/:year` (public, cached)** for status, timezone and dates, because the slot props are only `{ year }`. On the year page this is the same cached request. On Home (upcoming mode) it adds one request for members only.
- **Inline form, not the wireframe's "Sí, voy" dialog.** The brief asked for segmented Sí/Tal vez/No with guests, dates, hotel and notes. One inline card is fewer taps than a sheet, and the saved state shows the wireframe's "¡Vas! Tú + 2 acompañantes / Cambiar respuesta".
- **The date window is ± `RSVP_DATE_WINDOW_DAYS` (14)** around the edition, in its timezone, mirroring T3-BE. The server stays the authority (400 at the field).
- **The client also locks once the deadline's local day is over** (`isPastDeadline`, same rule as T3-BE's `rsvpEditability`), even when a cached response still says `editable: true`. The server's 409 is still handled (rollback, then a refetch that locks the card).
- **CSV filename:** `cuencada-{year}-rsvps.csv`, the same name as T3-BE's `Content-Disposition` (which isn't readable here, because the body is consumed as text).
- **Admin attendance uses `PUT` (replace-set)** rather than the contract's `POST { add, remove }`: saving the checklist is one atomic statement of who attended.
- **Bundle:** none of the T3 code is in the initial chunk (checked: no `rsvp` strings in `index-*.js`). The card and circles ship in the shared Cuencada page chunk. The admin page is its own 3.7 KB gzip chunk.

## Requests (→ orchestrator / owners)
1. ~~**R1, contract:** add `isMe` to `Attendee`.~~ **Done** by T3-BE; the web uses it.
2. **R2, T2-FE (`AdminCuencadaEditPage.tsx`, not mine):** add a link to `/admin/cuencadas/{id}/asistencia` (e.g. "Asistencia y confirmaciones" next to "Ver página"). Today the screen is reachable only by URL. T8's admin shell should list it under "Asistencia" too.
3. ~~**R3, T6-BE:** `GET /family/people`.~~ **Resolved**: it is on main. People beyond the first 100 are reached by searching; people with no `people` row must be created through T6 first (no add-by-name here).
4. ~~**R4, T3-BE:** confirm the error codes.~~ **Resolved**: 403 `FORBIDDEN` on `/attendees` when unverified; 409 `CONFLICT` on a closed `PUT rsvp/me`. Both handled.
5. ~~**R5, T3-BE:** CSV encoding.~~ **Resolved**: `text/csv; charset=utf-8` with a BOM; the web keeps exactly one.
6. **R6, contract:** `Attendee.avatarUrl` has no URL rule (`z.string()`). Consider `assetUrlSchema`/https-only. The web already filters.

## Verification (2026-10-06, after merging T3-BE / T6-BE)
- `pnpm lint`: biome, 0 diagnostics. `pnpm turbo run typecheck --force`: 6/6.
- `pnpm test` (root, after also merging #17/#18): 104 files, 1106 tests, all passing. T3-related web files unchanged by that merge. T3 adds 40 tests in 5 files:
  - `lib/rsvpForm.test.ts` (15): ±14-day date window across months and years, `isPastDeadline` (open all of the deadline's local day, closed at local midnight), guest clamp, required status, departure < arrival, window bounds, hotel not in the list, "No" clears fields, notes length, optimistic shape
  - `components/RsvpCard.test.tsx` (13):
    - visitors render nothing and call no API
    - create (body checked)
    - only the hotel options
    - update
    - read-only after the deadline, including a client-side lock
    - departure < arrival blocks the PUT
    - missing status
    - optimistic summary, then rollback
    - 409 `CONFLICT`: server message, refetch, card locks
    - past-edition badge from `isMe`; ids alone don't count; no badge
  - `components/AttendeesCircles.test.tsx` (5): visitors, 5 + "+7" stack with the user first, Dialog list and close, past title, 403 verify message, empty state
  - `admin/AdminAttendancePage.test.tsx` (5):
    - one replace-set `PUT { personIds }`
    - toggling back drops the edit
    - accent-insensitive search
    - RSVP totals and filter
    - CSV: a request without the token in the URL, a Blob with exactly one BOM, `a[download]` named `cuencada-2027-rsvps.csv`, the anchor removed and the blob URL revoked afterwards
  - `slots.test.tsx` (2): the real `/cuencada/2027` page shows both slots to members; visitors get neither and no RSVP/attendee requests
- `pnpm build` passes. `pnpm --filter @cuencada/web size`: **169.90 KB gzip** initial JS (after merging T6-FE) (budget 190). T3 adds nothing to the initial chunk. `AdminAttendancePage` chunk: 9.4 KB raw / 3.7 KB gzip (+0.95 KB CSS).
- **Screenshots** in `docs/ux/screenshots/t3/`, at 375 and 1280, taken with headless Chromium against `vite preview` with `/api/**` stubbed and device timezone Europe/Madrid:
  - `rsvp-abierto` (form with Sí, 2 guests, dates and hotel)
  - `rsvp-cerrado` (after the deadline)
  - `asistentes` (attendee sheet open)
  - `admin-asistencia` (checklist with 2 unsaved changes)
  - `admin-confirmaciones` (totals, filters, cards)
- **320px check:** on all 5 states, `scrollWidth === clientWidth` (320), and no element extends past the viewport outside a scroll container.

## Review log
- 2026-10-06, aligned with the merged T3-BE (orchestrator): `Attendee.isMe` replaces the id matching; 409 `CONFLICT` for closed RSVPs; admin attendance saved with `PUT { personIds }`; `RSVP_DATE_WINDOW_DAYS` (±14); deadline shown and enforced by local day; one CSV BOM; blob URL revoked (TL); `maybe` rows dropped from the strip (T3-BE lists `yes` + attendance). Screenshots re-taken.
- 2026-10-06: fixtures and screenshots switched to fictional people only (public repo); screenshots re-taken. Web tests: 54 files, 471 passing after the main merge.
