# WP-T2-FE Cuencadas content (web)
Owner: Frontend · Reviewers: TL, Sec · Branch: wp/t2-fe-cuencadas · PR: # (not opened)

## Scope
- **API** (`features/cuencadas/api.ts`, injected into the frozen `baseApi`):
  - `getCuencadaHome` → `GET /cuencadas/home`
  - `listCuencadas` → `GET /cuencadas`
  - `getCuencada(year)` → `GET /cuencadas/:year` (public; the response T9 caches)
  - `getCuencadaMembers(year)` → `GET /cuencadas/:year/members`, only requested when a member is logged in
  - `listMemberAnnouncements` → `GET /announcements` (first page)
- **Admin API** (`features/cuencadas/admin/api.ts`, in the admin chunks only):
  - Cuencada list/detail/create/PATCH (including publish via `{ isPublished }`)/delete
  - itinerary and locations: create/PATCH/delete plus `PUT …/order`, with an optimistic reorder that is rolled back on error
  - daily messages: list, import, delete
  - announcements CRUD
- **Tags:**
  - Reads provide `Cuencada` (by id, plus `LIST`), `CuencadaHome` and the `LIST` tags of `Itinerary`, `Location`, `Announcement` and `DailyMessage`.
  - Every admin mutation invalidates the matching `LIST` and `CuencadaHome`, so the public pages refresh after an edit.
- **Home `/`** (`pages/HomePage.tsx`):
  - The hero shell ("CUENCADA" plus the tagline) paints before data arrives, for a fast LCP.
  - **Upcoming/active** (`featured`): the kicker with the city and date range in the edition's timezone, a live `Countdown`, "Ver programa" (`/cuencada/{year}#programa`) and `<RsvpSlot>`.
  - **Memories** (`latestPast`):
    - "Gracias por una Cuencada inolvidable"
    - "Gracias por acompañarnos. La Cuencada 2026 en Mérida ya es parte de nuestra historia."
    - "Ver recuerdos de 2026" → `/galeria/2026` and "Ver programa 2026"
    - the photo mosaic, the "La próxima Cuencada" card, and past editions as chips
  - **None** (no featured and no past edition): "Muy pronto anunciaremos la próxima Cuencada."
  - Announcements: the public portal-wide ones, plus the members-only ones (deduplicated) when logged in.
  - Today's message is shown only if `todayMessage.date` equals today **in the Cuencada's timezone**, so a cached response from yesterday never shows a stale message.
- **`/cuencada/:year`** (`pages/CuencadaYearPage.tsx`), in this order:
  1. hero (title, description, countdown or the past-edition message)
  2. offline note (when stale)
  3. daily message
  4. section links
  5. public **Avisos**
  6. **Programa** timeline: a date column, then cards with the time range, `priceNote` and tags
  7. **¿Dónde estamos?** cards with the Maps and website links, exactly as the API returns them
  8. **Clima**
  9. **Nuestra canción** (`<audio controls preload="none">`)
  10. **Para la familia**: a lock card for visitors; for members, WhatsApp, the shared album, the slots and members-only announcements
  - Members get the full `itinerary`/`locations` lists in place of the public ones; members-only rows carry a "🔒 Solo familia" badge.
  - `:year` is parsed with `yearParamSchema`. An invalid year or an API 404 renders "No encontramos esa Cuencada".
- **Slots for T3/T4** (`components/slots.tsx`): `<RsvpSlot year>`, `<AttendeesSlot year>` and `<GalleryPreviewSlot year>`, each with a `data-slot` hook. Replace the function bodies and keep the names and props.
- **Admin** (`/admin/cuencadas`, `/admin/cuencadas/:id`), mounted from `features/cuencadas/routes.tsx` under `admin`. React Router ranks these paths above the admin feature's `/admin/*`, so `features/admin` is untouched.
  - **List page:** cards with a Publicada/Borrador badge, a "Nueva" form (created as a draft), and the portal-wide "Avisos generales" CRUD.
  - **Editor page:**
    - a publish `Switch`, which sends `PATCH { isPublished }`
    - "Borrar borrador" (drafts only, behind an alertdialog)
    - Tabs: Datos, Programa, Lugares, Mensajes, Avisos
  - Itinerary and location editors reorder with ↑/↓ `IconButton`s and no drag library; itinerary items only move within their own day.
  - **Daily messages:** a paste box that runs the shared `parseDailyMessagesText` before sending. It lists every bad line ("Línea 3: Fecha inválida…") with the offending text and sends nothing until the whole text is valid. The server's 400 `lines.N` details are shown the same way. Merge/replace is a `Select`.
  - **Forms:**
    - validated with the contract `create*InputSchema`s plus Spanish pre-checks for numbers and ranges (zod skips object refines while any field is invalid)
    - server `VALIDATION` details are mapped onto fields, and 409 → "Ya existe una Cuencada con ese año."
    - date-times are typed **in the edition's timezone** (`zonedLocalToIso` / `isoToZonedLocal`), not the device's
    - sticky save bar above the BottomNav
- **Offline:**
  - When a refetch fails, RTK Query keeps the last data. The pages keep rendering it with "📴 Sin conexión. Mostramos la última información guardada." and a "Reintentar" button.
  - A first load with nothing cached shows a "Sin conexión" state.
  - When member data can't load, "Necesitas conexión para ver la sección de la familia." is shown instead of the lock card.
  - `refetchOnReconnect` (WP-0.6) recovers by itself.
- **Removed:**
  - `src/data/cuencada2026.ts` and all its imports
  - the hard-coded countdown in Home (it now uses `Countdown`, and `useNow` uses `computeCountdown` to stop ticking after the edition ends)
  - the `.btn.whatsapp` rule and its `TODO(T2)` in `styles.css` (no longer used; members get the ink-on-green `Button variant="whatsapp"`)
- **Unchanged:**
  - The `TODO(T1/T2)` `.kicker` note stays, because the auth/other stub pages still use `.kicker`. T2 pages use `.cu-kicker` on green only.
  - My h1 classes reset the legacy global `h1` margin.

## Clima [SEC] (final design, after two orchestrator revisions)
- **No third-party script is ever injected into our document.** `components/WeatherWidget.tsx` renders weatherwidget.io's own frame directly:
  - `<iframe src="https://weatherwidget.io/w/" sandbox="allow-scripts allow-same-origin allow-popups" referrerpolicy="no-referrer" loading="lazy" title="Clima en {ciudad}">`
  - `allow-same-origin` is weatherwidget.io's own origin, which is cross-origin to us.
- **The loader's job, done by us.** I read `https://weatherwidget.io/js/widget.min.js` as text in the scratchpad and did not run it. On frame `load`, its loader posts this object to `"https://weatherwidget.io"`:
  - `{ id: "weatherwidget-io-0", href, label_1, label_2, theme, …27 style keys }`
  - every style key is `null` unless a `data-*` attribute set it
  - the frame replies with `{ wwId, wwHeight }`
- **We mirror the legacy anchor:** `href` = the forecast7 URL, `label_1` = "MÉRIDA, YUCATÁN" (city + state, upper-case), `label_2` = "CLIMA", `theme` = "original", and the other keys `null`.
- **Incoming messages:**
  - accepted only when `event.origin === "https://weatherwidget.io"` **and** `event.source === iframe.contentWindow` **and** `wwId` matches
  - only a numeric `wwHeight` is read, clamped to **150–250 px** (Security L6)
  - the listener is removed on unmount
- The frame starts at 150 px, inside a Card in the "🌤️ Clima en {ciudad}" section.
- It is rendered only on `/cuencada/:year`, and only when `weatherWidgetUrl` is an `https://forecast7.com/…` URL.
- Earlier attempts, now removed: script injection into the SPA, then a `/widgets/clima.html` page sandboxed without same-origin, which broke the widget's nested frame and postMessage.
- **For WP-2.4:** the app CSP needs `frame-src 'self' https://weatherwidget.io`. No `script-src` entry is needed for weatherwidget.

## Interfaces consumed / exposed
- **Consumed:**
  - `@cuencada/types` cuencadas contracts (no amendments to `cuencadas.ts`)
  - `shared/lib/dates.ts`, `shared/ui/*`, `baseApi`, `errors.ts`, and the auth selectors
- **Exposed:**
  - `features/cuencadas/components/slots.tsx` (T3/T4)
  - `cuencadasApi` / `cuencadasAdminApi` hooks
  - `testing/fixtures.ts` (contract-shaped 2026 fixtures for tests and screenshots; test-only)

## Decisions
- **Members endpoint is `/cuencadas/:year/members`**, per the WP-0.2 table and the `MemberCuencadaDetails` JSDoc. The dispatch brief said `/details`; the contract wins. T2-BE, please confirm.
- **Tags are derived.** `ItineraryItem` has no tags field, so the badges come from `locationName` (📍), a missing `startTime` ("Horario por confirmar") and `visibility: members` ("Solo familia"). See R1.
- **Announcement bodies are plain text.** `https://` links are made clickable by `LinkifiedText`, the only "markup" (the seed puts the "Ver letra oficial"/"Ver programa completo" links in bodies). No HTML from the API is ever interpreted.
- **Links are not rewritten.** Legacy production links are rendered exactly as the API returns them, but only if they are `https:` (defence in depth, `safeHttpsUrl`). Song and hero paths also accept `/images/…` and `/canciones/…`.
- **Portal-wide dates use `America/Merida`.** Portal announcements have no edition timezone, so their dates are shown in the family's home timezone.
- **Admin bundle:** the admin API and forms load only with the admin routes. Initial JS went from 166.0 to 166.5 KB gzip.

## Requests (→ orchestrator / owners)
1. **R1, contract (T2-BE/Architect):** add `ItineraryItem.tags: string[]` (≤ 6, ≤ 40 chars each) so the legacy tags ("🚌 Transporte incluido", "🌮 Taquiza") can be ported. Today they're derived.
2. **R2, contract:** add "Tips Cuencada" and "Actividades extras" (legacy sections) to the content model, for example `PublicCuencada.tips: { title, body, icon }[]` and `extras`, or announcement `kind`s. Until then they are **not ported**.
3. **R3, contract:** `CuencadaSummary` has no `timezone`, so lists can't format dates correctly. Admin cards use `AdminCuencada.timezone`; public chips show year · city only.
4. **R4, contract:** add a `songCaptionsUrl` / lyrics link. The `<audio>` has a `biome-ignore useMediaCaption` until then. The legacy VTT is a placeholder.
5. **R5, WP-0.6/app (`AppLayout.tsx`, not mine):** the `TODO(T2)` "Programa" tab still points at `/cuencada/2026`. It should use `featured?.year ?? latestPast?.year` from `useGetCuencadaHomeQuery`, which is now available from `features/cuencadas/api`.
6. **R6, WP-0.7 (`shared/ui/Countdown.tsx`):** `Countdown` computes with its own `getCountdown`, which duplicates `computeCountdown` in `shared/lib/dates.ts`. Please make it use `computeCountdown` and drop `getCountdown`. T2 already uses `computeCountdown` for ticking.
7. **R7, admin GET filter:** `GET /admin/announcements` can't filter for portal-wide announcements only (`cuencadaId=null`). The web filters client-side. Consider `?scope=portal`.
8. **R8, T4:** the Home memories mosaic uses the 4 static public photos in `public/images/fotos`. Replace it with admin-picked public highlights when T4 has them.
9. **R9, WP-2.4 CSP:** add `frame-src 'self' https://weatherwidget.io`. Nothing else third-party is loaded by T2 pages.
10. **R10, WP-0.1:** under heavy machine load, lazy-route tests can exceed Testing Library's 1 s `findBy` default. My three route-level test files raise `asyncUtilTimeout` to 5 s locally. A shared setting in `test/setup.ts` may be worth it.

## Open questions
- **Live mode.** The wireframe shows a "Hoy" card (Ahora/Sigue) during the event. It isn't built; it's a follow-up if wanted for 2027.

## Verification (2026-10-06)
- `pnpm lint`: 0 diagnostics. `pnpm typecheck`: 5/5. `pnpm test`: 42 files, 392 passed, 1 todo.
- T2 tests: 54 across 6 files:
  - `HomePage.test.tsx`: past, upcoming and none modes; daily message in the Mérida timezone; offline
  - `CuencadaYearPage.test.tsx`:
    - anonymous vs member (and no members request when anonymous)
    - America/Merida formatting
    - the weather frame and no third-party script
    - no widget when it isn't configured
    - the audio player
    - 404 and an invalid year
    - offline members block
  - `WeatherWidget.test.tsx`:
    - sandbox flags
    - `postMessage` to the exact origin
    - origin/source/shape filtering
    - the 150–250 clamp
    - unmount cleanup
  - `admin.test.tsx`: list; create validation; timezone-correct body and 409 mapping; ↑ reorder; client and server import line errors
  - `format.test.ts`, `forms.test.ts`: helpers, DST, clamping, reorder
- `pnpm build` passes. `pnpm --filter @cuencada/web size`: **166.52 KB gzip** initial JS (budget 190).
  - CuencadaYearPage chunk: 4.2 KB gzip
  - HomePage chunk: 2.2 KB gzip
  - admin editor: 6.3 KB + forms 9.9 KB gzip (admin only)
- **Screenshots** in `docs/ux/screenshots/t2/`, at 375 and 1280, taken with headless Chromium against `vite preview` with `/api/**` stubbed from `testing/fixtures.ts`, device timezone Europe/Madrid:
  - `home-memories`
  - `cuencada-2026-anon`
  - `cuencada-2026-member`
  - `admin-programa`
  - `admin-mensajes-errores`
- **320 px check:** `scrollWidth === clientWidth` on all 5 pages, and no element extends past the viewport outside a scroll container.

## Review log
- 2026-10-06: Clima redesigned twice at the orchestrator's request: script injection → sandboxed same-origin page → direct weatherwidget.io frame with the postMessage config. The Security L6 clamp is 150–250 px.
