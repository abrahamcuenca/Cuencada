# WP-5.4 Events web ("Eventos")
Owner: Senior JS frontend + UI/UX · Branch: `wp/5.4-eventos-web` · PR: (not opened)

Based on `origin/main` @ 484405d (WP-5.2 contracts). Built against the WP-5.2 contracts (`packages/types/src/events.ts`, route list in `docs/coordination/WP-5.2.md`) and WP-5.3's notice contract, with MSW mocks; the server (WP-5.3) lands in parallel. ADR 0001 §7 WP-5.4 requirements: all met (see "Security").

## What shipped
### Pages (all lazy)
- **`/eventos`**:
  - cards with the 16:9 cover (a gradient with 🎉 when there is none or it fails to load), badges ("Borrador", "Oculto", "Solo participantes", "Organizas"/"Participas"), title, dates or "Por anunciar · {año}", place, summary (3 lines) and participant count
  - "Próximos"/"Pasados" tabs, a year filter and a "Mis eventos" switch, kept in the URL (`?cuando=pasados&anio=2025&mios=1`)
  - keyset "Cargar más", empty states, "＋ Crear evento", and the consent notices on top
  - one stretched link per card (one tab stop, the whole card is the tap target)
- **`/eventos/:year/:slug`**:
  - the hero: cover; badges; title; dates (or "Por anunciar"); place; "Organiza(n): …"
  - "Me apunto" (`canJoin`) / "Salir del evento" (`viewerRole && canLeave`, with a confirmation whose copy differs for participants-only events); the last organizer sees why they cannot leave
  - tabs Detalles · Chat · Fotos (`?vista=`): summary, details and participants (8 then "+N" opening the full list); the embedded chat; the album picker and gallery
  - the "Organización" panel for `canManage`: Editar evento, Personas, Álbumes, Publicar / Pasar a borrador, Ocultar / Mostrar (admins only), Eliminar (`canDelete`), and the cover controls
- **`/admin/eventos`** (Panel → Eventos): every event (`GET /api/admin/events`), status and visibility filters, Ocultar (confirmed) / Mostrar (back to `published`, or `draft` if never published), Eliminar (confirmed).
- **Home**: one lazy chunk (`HomeEvents`) for members with the consent notices and "Próximos eventos" (max 3, "Ver todos"), silent when empty, loading or failing.

### Create/edit sheet (`EventFormSheet`)
- Fields: title; summary with an `n/280` counter; details; dates; place; visibility; publish.
- Dates are a "Ya tenemos fecha" switch: off → "Por anunciar" plus a year (this year to +3); on → start and end `datetime-local` in Mérida time. Both or neither.
- Visibility is a radio pair: "Todos los miembros" / "Solo participantes", each with help text.
- "Publicar ahora" (create) or "Publicado" (edit) explains drafts (only organizers and admins see them); a hidden event says only an admin can show it again.
- Validated client-side with the contract schemas (`createEventInputSchema`, `updateEventInputSchema` and the admin variants). An edit sends only the changed fields.
- **Slug:**
  - members see a read-only preview, `/eventos/{año}/{slugifyEventTitle(title)}-····`, and "Al guardar, la dirección lleva un código corto al final para que sea única."; when editing, the real address and "No cambia aunque cambies el título."
  - admins get an editable "Dirección (slug)" and the admin endpoints; `EVENT_SLUG_TAKEN` is shown on the field
  - after a save that changes the year or slug, the page navigates to the returned address

### Manage
- **Participants:**
  - the picker searches the directory (`GET /api/directory`: listed members only), hides people who already participate, multi-selects, and adds with the consent copy "Les avisaremos y podrán salir cuando quieran."
  - remove (confirmed) and promote/demote
  - the last organizer's buttons are disabled with "Es la única persona que organiza: nombra antes a otra."; the server's `EVENT_LAST_ORGANIZER` is explained too
- **Albums:** create, rename, delete (confirmed); `EVENT_ALBUM_NOT_EMPTY` → "Este álbum tiene fotos. Bórralas (o muévelas) antes de eliminarlo."
- **Cover:** the WP-4.3 `ImageCropper` at 16:9, then the avatar upload flow (`usePhotoUpload`) on `/events/:id/cover/uploads` → `…/confirm`. "Quitar portada" is confirmed.
- **Error codes:** every `EVENT_*` detail code has a Spanish message (`eventErrorMessage`); unknown codes fall back to the server's message.

### Cropper `aspect` option (WP-4.3 components)
- `cropMath` works in an `aspect × 1` viewport (one unit = the frame's height); every function takes `aspect` last, defaulting to 1, so the square behaviour and its tests are unchanged.
- `cropCore.drawCrop` draws into any `{width, height}` (`drawSquareCrop` wraps it), and `resizeCore`/the worker accept a size.
- `resizeImage.cropImageToRect(file, spec, {width, height})` sits next to `cropImageToSquare`.
- `ImageCropper` gains `aspect`, `outputSize` and `description`. A wide frame has no circle (an outline instead), the hint "…dentro del marco." and a 1920×1080 JPEG output.
- `useCropStep(onCropped, title, { aspect, description })`.

### Gallery scoped to event albums (`gallery/lib/mediaScope.ts`)
- A `MediaScope` is an edition year or an event album.
- The gallery API gains `listAlbumMedia`, `albumMediaHead` and `createAlbumUpload` (the same `parseUploadIntent` origin check [SEC]).
- `confirmUpload` takes a scope; caption edits and deletes patch the album list (`albumOf(item)`).
- The upload manager keys rows by scope (`scopeKey`/`scopeLabel`, `year` is `null` for album rows), polls `albumMediaHead` for processing album uploads, and discards cancelled album uploads correctly.
- `Uploader` takes `year` or `scope`; `UploadPanel` labels rows from another scope.
- No new upload path: the Fotos tab uses the gallery's `MediaGrid`, `GalleryLightbox`, `Uploader` and `UploadPanel`, so the upload-origin gate is the same.

### Chat
- **Event rooms:** they show 🎉 and the event title (plus "(evento)" for screen readers); the conversation header gets "Ver evento" (to `/eventos/{year}/{slug}`).
- **`room_removed`:**
  - the room list drops the room (`applyRoomRemoved`)
  - the room's cached history is replaced by an empty thread, pending messages included [SEC]
  - `/chat` closes the conversation if it is that room and toasts "Ya no participas en {evento}." (titles are remembered, so the toast still names a room the cache already dropped)
  - the event page refetches, which turns into the 404 screen when the event became invisible
  - all through `useRoomRemoved` (`chat/lib/useRoomRemoved.ts`)
- **Chat tab:** it embeds `Conversation` (`embedded`: no back arrow, no "Ver evento") in a bounded card and opens the shared socket like `/chat`; "Abrir en el chat" goes full screen. Non-participants get "Apúntate para chatear" (or why there is no chat: draft, participants-only).

### Consent notices (WP-5.3 contract)
- The contract is copied shape for shape into `events/notices/contract.ts`: `EventNotice`, `EVENT_NOTICES_MAX`, and `parseEventNoticeList` standing in for `eventNoticeListSchema.parse` (the web has no direct zod dependency). It is not imported from WP-5.3's branch; when 5.3 merges, swap the imports and delete the file.
- `GET /api/events/notices` (malformed items dropped, capped at 20); "Entendido" = `DELETE /api/events/:id/notice` (optimistic); "Salir" = `DELETE /api/events/:id/participants/me` (hidden when `canLeave` is false). Leaving invalidates the notice list.
- The copy reads "Rosa te agregó (como organizador) a «…». Puedes salir cuando quieras."; without a name, "Te agregaron a «…»."
- `EVENT_NOTICES_AVAILABLE = true`. It is isolated in `notices/` (its own API slice, its own component) for WP-6's notifications bell to replace.

## Decisions
1. **Nav fit: "Eventos" in the TopNav from 1000 px.**
   - At 900 px the bar already holds five links plus the account button (WP-4.7 measured about 920 px for six links), so a sixth link does not fit.
   - The new `NavItem.wideOnly` hides it below 1000 px (CSS) and `TOP_NAV_WIDE_MIN_PX` exports the threshold.
   - Below 1000 px the account menu lists "Eventos" after "Sesiones y seguridad", using the new `shared/lib/useMediaQuery` hook (rendered, not CSS-hidden, so the menu's arrow keys never land on a hidden entry).
   - Phones also have Más → Eventos. The BottomNav is unchanged.
   - Screenshots: `nav-900`, `nav-menu-900`, `nav-999`, `nav-1000`, `lista-1280`.
2. **One `Event` cache tag** (`LIST`, `ADMIN-LIST`, `NOTICES`, one per event id), added to `API_TAG_TYPES`. Writes invalidate rather than hand-patch; participation and visibility writes also refresh the chat room list.
3. **The 404 parity is enforced in one place** (`EventNotFound`, `EVENT_NOT_FOUND_TITLE`/`TEXT`):
   - a malformed address (`eventPathParamsSchema` fails: no request at all), a 400, a missing event and an invisible one render byte-identical pages
   - a refetch that turns 404 (lost access) replaces cached data with the same screen
4. **Embedded chat instead of a redirect:** the tab reuses the whole conversation (history, live frames, read state, composer), with a link to the full-screen view for phones with a keyboard.
5. **The gallery got a scope rather than a fork.** Album media reuses every piece of the gallery, including its moderation and caption dialogs; the only new endpoints are the album list/head/upload intent.
6. **Consent copy is plural in the picker** ("Les avisaremos y podrán salir cuando quieran.", the brief's wording) because it adds several people at once; ADR 0001 §7's singular sentence describes the same promise.

## Security (ADR 0001 §7, WP-5.4 requirements)
- **Invisible = missing:** identical "No encontramos ese evento" screen (tested, including a malformed slug that never reaches the server).
- **Picker:** directory only (listed members), consent copy shown; admins use the same picker in the UI (the API also lets them add by id).
- **`room_removed`:** handled as required (list, open conversation, cached history), with a toast.
- **No new upload path:** the gallery uploader/grid/lightbox and the WP-4.3 cropper (16:9 via `aspect`); the cover intent is validated by `usePhotoUpload` (`avatarUploadResponseSchema` + bucket-origin check).
- **Slugs:** members never type one; the preview carries the "código corto" copy; only admin screens edit slugs.
- Buttons follow the server-computed flags (`canManage`, `canJoin`, `canLeave`, `canDelete`, `hasChat`); "Ocultar"/"Mostrar" and the slug field are admin-only in the UI. The server enforces everything again.

## Tests
- **Unit:** `events/lib/format.test.ts` (dates in Mérida, "Por anunciar", badges, slug preview and copy, `EVENT_*` messages) and `events/lib/form.test.ts` (create/update mapping: no member slug, both dates or neither, year only when undated, minimal PATCH, hidden status untouched, admin slug, Mérida year at New Year).
- **Pages (RTL + MSW, `events/testing/fixtures.ts` fake server):**
  - `EventsPage`: cards, tabs/filters in the URL, Cargar más, empty state, create with the slug copy and no slug in the body, admin slug and endpoint
  - `EventDetailPage`: 404 parity, hero/participants "+N", Por anunciar, join/leave, the last-organizer note, member vs organizer vs admin controls (edit PATCH, admin slug PATCH → navigation, hide), the picker (consent copy, directory only, body), the last-organizer guard, the album 409 message, the Fotos album picker and grid, non-participant prompts, the embedded chat and `room_removed`
  - `AdminEventsPage`: list, filter, hide/unhide/delete, the Panel entry
  - `HomeEvents`: the strip (max 3, hidden when empty), notices (copy, Entendido, Salir, `canLeave`), Más → Eventos, `parseEventNoticeList`
- **Chat:** `ChatPage.events.test.tsx` (icon/title, "Ver evento", `room_removed` closes the open room, clears the cache and toasts; another open room stays).
- **Cropper:** 16:9 cases in `cropMath.test.ts`, `cropCore.test.ts` and `ImageCropper.test.tsx`; the square tests are unchanged and green.
- **Nav:** `AccountMenu.test.tsx` (Eventos below 1000 px, dropped from 1000 px) and `AppLayout.test.tsx`.
- **e2e:** `tests/e2e/events.spec.ts` covers the plan's combined pass: the participants-only trip with two relatives, the notice, chat, an album upload, a non-participant's list and 404s, the admin, and "Me apunto" on an all-members event. **`test.fixme` until WP-5.3 is merged:** flip `EVENTS_SERVER_PENDING`.
- **Quality gates (`quality.spec.ts`, 320/375 + axe):**
  - `eventos` (member) and `admin-eventos` (admin) run now; they render their headings even before WP-5.3
  - "the event pages (WP-5.4)" (detail, chat and fotos tabs, the create sheet, the 404 screen) is `test.fixme` until WP-5.3, because it creates an event through the API

## Screenshots
`docs/ux/screenshots/eventos/`, 375 (2x) and 1280:
- `lista`, `detalle`, `detalle-organizacion`, `participantes`, `chat`, `fotos`
- `crear`, `crear-admin`, `agregar-personas`, `portada-recorte`
- `no-encontrado`, `home`, `salas-chat`, `admin`, `mas`
- also `lista-320`, `detalle-320`, and the nav fit at 900/999/1000 (`nav-*`, `nav-menu-900`)

They were taken with headless Chromium against the Vite dev server with `/api/**` stubbed by `page.route` and the socket by `page.routeWebSocket`; data is fictional and covers are generated SVGs. Horizontal overflow was 0 px on every shot.

## Bundle
Initial JS: **180.57 kB gzip** (budget 190). The events pages, the Home strip and notices (`HomeEvents`, about 0.6 kB plus the shared events chunks), the admin page and the cropper are all lazy chunks.

## Follow-ups
- When WP-5.3 merges:
  - flip `EVENTS_SERVER_PENDING` in `events.spec.ts` and remove the `test.fixme` in the quality gate
  - replace `notices/contract.ts` with the `@cuencada/types` exports
  - run `pnpm e2e`
- WP-6: replace `notices/` with the notifications bell.
