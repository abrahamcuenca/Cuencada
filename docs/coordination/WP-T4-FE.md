# WP-T4-FE Gallery & uploads [SEC]
Owner: Frontend · Reviewers: TL, Sec · Branch: wp/t4-fe-gallery · PR: # (not opened)

Built on `origin/main` (ff0d4d9, WP-0.6 merged) against the WP-0.2 media contracts. T4-BE is parallel, so every test uses MSW plus a fake `XMLHttpRequest`.

## Scope
All files are under `apps/web/src/features/gallery/`. No edits to `router.tsx`, `store.ts`, `baseApi.ts`, `shared/ui/**`, `shared/styles/**` or `packages/types`.

| File | What |
|---|---|
| `api.ts` | Endpoints: `listMedia` (infinite), `mediaPreview`, `galleryYears`, `createUpload`, `confirmUpload`, `updateMediaCaption`, `deleteMedia`, `reportMedia`, `listAdminMedia` (infinite), `mediaReports`, `moderateMedia` |
| `routes.tsx` | `/galeria/:year?` (member) and `/admin/media` (admin) |
| `pages/GalleryPage.tsx` | Default-year redirect, year switcher, grid, uploader, upload panel, Lightbox |
| `components/MediaGrid.tsx` | 3/4/5/6-column square grid (375/600/900/1200px), skeletons, infinite-scroll sentinel plus a "Cargar más" button |
| `components/GalleryLightbox.tsx` | Shared `Lightbox` with item actions (edit caption, delete, report) |
| `components/ItemDialogs.tsx` | Caption, delete-confirm and report sheets |
| `components/Uploader.tsx` | "Subir fotos y videos" button, hidden `<input type=file multiple>`, staging sheet with per-file errors and optional captions |
| `components/UploadPanel.tsx` | Sticky progress card (docked bottom-right at ≥900px): progress bars, Reintentar, cancel, "Quitar terminadas" |
| `components/GalleryPreview.tsx` + `index.ts` | `<GalleryPreview year>` for T2 |
| `upload/uploadManager.ts` | Upload queue: intent → XHR PUT → confirm, 2 at a time, retry, cancel, `beforeunload` guard, reset on logout |
| `lib/putToPresignedUrl.ts` | The XHR PUT (progress, abort, signed headers only, URL-free errors) |
| `lib/validateFile.ts` | Client-side allowlist and size checks from the contract constants, with Spanish reasons |
| `lib/useExpiredUrlRefetch.ts` | Refetch once when an `<img>`/`<video>` fails (expired presigned URL) |
| `admin/AdminMediaPage.tsx` | Moderation queue: Por revisar / Reportadas / Ocultas, Aprobar / Ocultar / Eliminar, report list |
| `testUtils.ts` | Fixtures, MSW handlers over an in-memory DB, `FakeXhr` (tests only) |

## Interfaces consumed / exposed
- **Consumed:**
  - `GET /cuencadas`
  - `GET /cuencadas/:year/media`
  - `POST /cuencadas/:year/media/uploads`
  - `POST /media/:id/confirm`
  - `PATCH` and `DELETE /media/:id`
  - `POST /media/:id/report`
  - `GET /admin/media`
  - `GET /admin/media/:id/reports`
  - `POST /admin/media/:id/moderate`
- **Tags:**
  - `Media`: `LIST-<year>` per year, `ADMIN-LIST`, `YEARS`, and one per item id
  - `MediaReport`: by media id
  - `Cuencada` `LIST` for the editions
  - Confirm invalidates the year list, `YEARS` and `ADMIN-LIST`.
  - Moderation invalidates every `Media` tag.
- **Exposed: `GalleryPreview` (for T2).**
  ```tsx
  import { GalleryPreview } from "../../gallery"; // features/gallery/index.ts
  <GalleryPreview year={year} />            // optional headingLevel={3}
  ```
  - It renders the "📸 Álbum vivo" heading, the latest 6 ready thumbnails (3 columns on phones, 6 at ≥600px) linking to `/galeria/{year}`, and a "Ver álbum" button ("Subir fotos" when the year is empty).
  - It renders **nothing** for visitors and for users with a pending password change, and makes no request. Put it where the wireframe's "📸 Álbum vivo → /galeria/2026" line is, and keep T2's own lock state for visitors.
- **Exposed: `/admin/media`.** T8 can link to it from the admin console's "Fotos y recuerdos" card. Admins also see a "🛡️ Moderar" link in the gallery header.

## Decisions
- **`build.infiniteQuery` instead of `merge` + `serializeQueryArgs` (deviation from the brief).**
  - RTK 2.13 ships infinite queries, which keep one cache entry per year (what `serializeQueryArgs` would do) and append pages by cursor (what `merge` would do).
  - With the `merge` pattern, a refetch, poll or tag invalidation re-runs only the **last** cursor. A new upload would never appear at the top, and the "expired URL → refetch" would only refresh the last page's URLs.
  - `infiniteQuery` re-runs every loaded page from the first cursor, so all three flows are correct with no custom cache code.
- **The upload queue lives outside Redux** (one `UploadManager` per store, read with `useSyncExternalStore`).
  - It holds `File`s and XHR handles, which aren't serializable, and `store.ts` is frozen.
  - Because it is per store and not per component, the list survives navigation (year switches, leaving the gallery and coming back).
  - **[SEC]** It subscribes to the store and aborts and clears everything when `sessionEpoch` or the user id changes (logout, cross-tab logout, user switch).
- **Upload pipeline [SEC]:**
  - The intent response is validated with `createUploadResponseSchema`, and `uploadUrl` must be `https:` (`http:` is allowed in dev only).
  - The PUT goes through XHR with `withCredentials = false` and no `Authorization` header, so the bearer token never reaches the bucket.
  - It sends only the intent's `headers`, minus forbidden request headers. **`Content-Length` is never set by hand**: the browser derives it from the `File`, which is the same `byteSize` that was signed.
  - Errors are mapped to fixed Spanish messages:
    - 403: "El permiso de subida venció"
    - network failure: "Se perdió la conexión…"
    - 5xx: "El almacenamiento no respondió…"
  - API errors use `getApiErrorMessage`. Neither the URL nor `error.message` is ever shown or logged; a test asserts the signed URL never appears in the DOM.
- **Retry and cancel:**
  - Retry reuses a still-valid intent (more than 60s before `expiresAt`) and skips a PUT that already succeeded.
  - A 403 or 4xx from the bucket drops the intent, so the retry gets a new one.
  - Cancel aborts the XHR and removes the row. The orphan `pending_upload` is left to the BE cleanup job (see Requests).
- **Concurrency:** at most 2 uploads at once (`MAX_CONCURRENT_UPLOADS`), started in queue order.
- **Staging sheet before uploading.** Picking files opens a bottom sheet that lists each file with its size, plus either an optional caption field or its rejection reason. Then "Subir N" queues the valid files.
  - Captions go into the intent, so there's no second PATCH.
  - This costs one tap compared with the wireframe's "start immediately", but it shows the per-file errors and captions in one place.
- **Validation:**
  - `accept` is exactly the contract allowlist (`image/jpeg,image/png,image/webp,video/mp4,video/quicktime`). Because `image/heic` isn't listed, iOS Safari converts HEIC photos from the photo library to JPEG.
  - An empty `File.type` falls back to the file extension.
  - HEIC files picked from Files are rejected with the "iPhone convierte automáticamente a JPG al subir desde el navegador…" explanation.
  - Limits come from `MEDIA_SIZE_LIMITS` (25 MB / 300 MB). The rules are also shown under the button.
- **Processing:**
  - The list polls every 5s (`skipPollingIfUnfocused`) only while a listed item has `uploadStatus: "processing"`, and stops when none do. The contract lists the caller's own non-ready items, so the user's new upload drives the polling.
  - The panel moves each row from "Procesando…" to "✅ Lista" from the polled list.
  - A confirmed item that is ready but absent or not `approved` shows "Enviada. Un administrador la revisará." (approval-first mode).
- **Expired URLs:** an `error` on a grid thumbnail, a preview thumbnail, an admin thumbnail or the Lightbox `<img>`/`<video>` triggers one refetch of the list. Further errors within 5 minutes are ignored, so a genuinely broken file can't cause a refetch loop. React propagates media errors, so one `onError` on a wrapper covers the shared Lightbox without editing `shared/ui`.
- **Default year (`/galeria`):**
  - Calls `GET /cuencadas`, then probes up to 5 editions newest first with `?limit=1`, and redirects (`replace`) to the first edition that has media.
  - If none has media, it falls back to the newest edition that has started, else the newest edition.
  - An invalid `:year` shows "Ese año no existe".
- **Permissions (UX only; the server enforces them):**
  - "Editar descripción" and "Eliminar" show when `isMine` or for an admin.
  - "Reportar" shows when the item isn't `isMine`.
  - A 409 on report reads as "Ya habías reportado…".
  - Abort errors never toast (`isAbortError`).
- **Dates:** "Subida por {nombre} · 14 sep" uses `formatDate` with `America/Merida` (see Requests 2). The uploader name falls back to "un familiar".
- **Bundle:** none of the gallery code is in the initial chunk.

## Requests / contract gaps (→ orchestrator)
1. **Years with media (T4-BE / Architect).** Add `GET /api/media/years` → `{ year, count }[]`, or `mediaCount` on `CuencadaSummary`, so `/galeria` doesn't need up to 5 probe requests. The FE only changes inside `galleryYears`.
2. **Edition timezone (T2 / Architect).** `CuencadaSummary` and `MediaItem` don't carry `timezone`. The gallery uses `America/Merida` (`GALLERY_TIMEZONE`, the contract default). Adding `timezone` to `CuencadaSummary` would let the FE drop that constant.
3. **Signed headers (T4-BE).**
   - The contract field is `CreateUploadResponse.headers`; the brief called it `requiredHeaders`.
   - The JSDoc says Content-Type **and Content-Length** are signed. A browser can't set `Content-Length`; it sends the `File`'s real size, which equals `byteSize`. Please keep `Content-Length` signed from `byteSize`.
   - Don't put other browser-forbidden headers (`Host`, `Cookie`, `Origin`…) in `headers`: the FE skips them, so the signature would fail.
4. **Bucket CORS (T4-BE / ops).** The Linode bucket must allow `PUT` from the app origin(s) with the `Content-Type` request header (plus any `x-amz-*` the server signs), and needs no credentials. Without this, every PUT fails as a network error.
5. **Cancel cleanup (T4-BE).** A cancelled upload leaves a `pending_upload` row and maybe a partial object. The FE relies on the abandoned-upload cleanup job. If you'd rather the FE call `DELETE /api/media/:id` on cancel, confirm the uploader may delete a `pending_upload` item.
6. **List semantics (T4-BE).**
   - The FE assumes `GET /cuencadas/:year/media` is newest first.
   - It assumes the caller's own `processing` / `failed` items are included (the contract says "own non-ready items").
   - It assumes an own item that is ready but in `pending_review` is **not** listed.
   - Please confirm, or list own `pending_review` items too; the panel handles both.
7. **Approval-first flag (orchestrator, open in WP-0.2).** The FE handles both modes: "Enviada. Un administrador la revisará." for uploads that need approval.
8. **Admin console link (T8).** Link "Fotos y recuerdos" in `AdminPage` to `/admin/media`. The route is registered by the gallery feature and outranks `/admin/*`.
9. **Download action (UX / Architect).** Wireframe 7.1's "⬇ Descargar" isn't built: `displayUrl` is a 1600px WebP, and there is no presigned GET for the original. Decide whether `GET /api/media/:id/original` (a presigned download) is wanted.
10. **Wireframe follow-ups:** none of these were in the brief.
    - the "Todas / Por día / Mis fotos" tabs and sticky day headers
    - desktop drag-and-drop ("Suelta tus fotos aquí")
    - minimising the panel to a pill
    - video duration badges (`durationSeconds` is available)

## Verification (2026-10-06)
- `pnpm lint`: biome, 0 diagnostics.
- `pnpm typecheck`: 5/5 tasks succeed.
- `pnpm test`: 41 files, 383 passed, 1 todo. The gallery has 5 files and 45 tests:
  - `validateFile`: type, HEIC, size boundaries, empty file, extension fallback, unsafe name
  - `putToPresignedUrl`: only the signed headers, no credentials, progress, 403/5xx/network errors without the URL, abort
  - **Grid:**
    - lazy thumbnails with width/height
    - empty state
    - `/galeria` redirect plus fallback
    - year switcher
    - cursor pagination
    - Lightbox image and video
    - expired-URL refetch: once, not looping, also from the Lightbox
  - **Processing:** polling every 5s stops once nothing is processing (fake timers)
  - **Uploads:**
    - client rejections (type, HEIC, image > 25 MB, video > 300 MB), with no request sent
    - happy path: intent body with caption → PUT with only `Content-Type` → progress 50% → confirm → list invalidated
    - "Procesando…" after confirm
    - PUT 500 then retry with the same intent, and the signed URL is never in the DOM
    - 403 then retry with a new intent
    - cancel aborts the XHR
    - at most 2 concurrent
    - `beforeunload` only while in flight
    - the list survives a year switch and is cleared (XHR aborted) on logout
  - **Item actions:** owner edits the caption (trimmed) and deletes after confirming but can't report; another member reports (reason required) but can't edit or delete; an admin can edit and delete
  - **Admin:** pending queue + approve, reported tab + report list + hide, hidden tab + delete after confirming, member kept out with no request
  - **`GalleryPreview`:** 6 thumbnails + links, empty copy, renders nothing and calls nothing for visitors
- `pnpm build`: succeeds. Gallery chunks:
  - `GalleryPage` 7.6 KB gzip
  - shared gallery chunk 7.5 KB gzip (+2.9 KB CSS)
  - `AdminMediaPage` 3.0 KB gzip
- `pnpm --filter @cuencada/web size`: initial JS **167.53 KB gzip** (budget 190 KB). No gallery code is in the initial chunk; only the lazy route entries are.
- **Screenshots** are in `docs/ux/screenshots/t4/`: `grid`, `lightbox`, `upload-sheet`, `upload-progress` and `admin-queue`, each at 375 and 1280.
  - They were taken with headless Chromium against the Vite dev server, with `/api/**` stubbed, placeholder images from `public/images/fotos/`, and a fake XHR (72%, failed, 18%, waiting).
  - Horizontal overflow measured **0 px** for all five screens at 320, 375 and 1280.

## Open questions (→ orchestrator)
- See Requests 1–10. Nothing blocks merge; 3, 4 and 6 need T4-BE confirmation before end-to-end testing.

## Review log
