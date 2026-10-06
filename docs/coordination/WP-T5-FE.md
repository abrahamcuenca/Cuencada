# WP-T5-FE Profile & directory [SEC]
Owner: Frontend · Reviewers: TL, Sec · Branch: wp/t5-fe-profile · PR: # (not opened)

Built on `origin/main` against the profile contract (`packages/types/src/profile.ts`), with migration 0002 (WP-2.1, `a8b6995`) merged in, so `visibility.listedInDirectory` is a contract field. T5-BE is parallel, so every test uses MSW. Per the orchestrator's correction, the form follows the **contract**: no birthday and no WhatsApp field (the phone covers WhatsApp).

## Scope
`apps/web/src/features/profile/**`, `apps/web/src/features/directory/**`, this doc and `docs/ux/screenshots/t5/`. Authorized by the orchestrator: re-exports in `features/gallery/index.ts` (Request 4) and two default handlers in `apps/web/test/msw.ts` (Request 8). No edits to `router.tsx`, `store.ts`, `baseApi.ts`, `shared/ui/**` or `packages/types`.

| File | What |
|---|---|
| `profile/api.ts` | `getProfile`, `updateProfile` (PATCH), `createAvatarUpload`, `confirmAvatar`, `deleteAvatar`. Writes upsert the cached profile, refetch `/me` (header name/avatar) and invalidate the caller's `Directory` entry and `LIST` |
| `profile/lib/profileForm.ts` | Form values, dirty-field diff (trimmed; blank = empty), PATCH builder validated with `updateProfileInputSchema` (Spanish errors) |
| `profile/lib/useAvatarUpload.ts` | Avatar pipeline: client check → object-URL preview → intent → XHR PUT → confirm, with progress |
| `profile/components/AvatarEditor.tsx` | 96px avatar, progress ring, "Cambiar foto", "Quitar foto" (confirm `alertdialog`), status `<output>`, error `role="alert"` |
| `profile/pages/ProfilePage.tsx` | `/perfil`: avatar card, "Tus datos", "¿Quién puede ver mis datos?" switches, sticky "Guardar cambios" while dirty, "Sesiones y seguridad" link |
| `directory/api.ts` | `listDirectory` (`infiniteQuery` by cursor, 30/page), `getDirectoryEntry`; `keepUnusedDataFor: 30` |
| `directory/lib/filters.ts` | Query builder (`q` from 2 chars, `familyBranch`, `city`), debounce constants, branch suggestions |
| `directory/lib/contactLinks.ts` | `whatsappHref` (`https://wa.me/<digits>`), `telHref`, `mailtoHref` |
| `directory/lib/useDebouncedValue.ts` | Debounce hook |
| `directory/components/*` | List (cards, sentinel + "Cargar más"), detail card, filters sheet, error/403 states |
| `directory/pages/DirectoryPage.tsx` | `/directorio/:userId?` |
| `*/testUtils.ts` | Contract-parsed fixtures and MSW handlers (tests only) |

## Interfaces consumed / exposed
- **Consumed:** `GET/PATCH /profile/me`, `POST /profile/me/avatar/uploads`, `POST /profile/me/avatar/confirm`, `DELETE /profile/me/avatar`, `GET /directory`, `GET /directory/:id`; T1's `ResendVerificationButton` and `refreshCurrentUser()`; T4's `putToPresignedUrl`, `UploadTransferError`, `isAllowedUploadUrl` and `useExpiredUrlRefetch` from `features/gallery/index.ts`.
- **Route change:** the directory route is now `/directorio/:userId?` (one route, so opening a person keeps the search, filters and loaded pages). `/directorio` still matches.
- **Tags:** `Profile` `ME`; `Directory` `LIST` and per `userId`.

## Decisions
- **Dirty-field PATCH.** The form stores only the user's edits on top of the server profile. Only fields whose trimmed value differs are sent; a cleared optional field is sent as `null`; a field typed back to its value is not sent. Only dirty fields are validated, so a legacy server value can't block an unrelated save. After a save the edits are dropped and the server's answer becomes the baseline.
- **Privacy switches** ("Aparecer en el directorio" = `listedInDirectory`, then `showEmail`, `showPhone`, `showCity`) are part of the form and saved with "Guardar cambios", each with a Spanish explanation; the section hint says hidden data is also hidden from search.
- **Avatar upload [SEC]** (same guards as T4):
  - `accept="image/jpeg,image/png,image/webp"`; type/size checked with `avatarUploadInputSchema` (Spanish messages) before any request. An empty `File.type` falls back to the extension.
  - The intent is validated with `avatarUploadResponseSchema` and `uploadUrl` must equal `VITE_MEDIA_UPLOAD_ORIGIN` (unset → refused). A refused intent shows "No pudimos subir la foto. Inténtalo otra vez." and nothing is PUT.
  - The PUT sends only the signed headers (forbidden ones like `Content-Length` skipped), `withCredentials = false`, no `Authorization`. The intent is `reset()` from the RTK store right after it's read; the signed URL never reaches the DOM (asserted).
  - The preview object URL is revoked on replace, on success (the server URL takes over), on failure and on unmount. Unmount (navigation, logout) also aborts the intent request and the XHR.
  - Progress: a conic ring around the avatar plus "Subiendo foto… 50 %" in a polite `<output>`.
  - **"Quitar foto"** shows only when there is a photo and no upload runs. It opens an `alertdialog` ("¿Quitar tu foto?", no backdrop close, danger action first), then `DELETE /profile/me/avatar`, toast "Quitaste tu foto."; errors toast the server message.
- **Directory search:** 300 ms debounce, `q` sent only from 2 characters (1 character shows the full list plus "Escribe al menos 2 letras para buscar."). Equivalent queries share one cache entry.
- **Filters** live in the shared `Dialog` (bottom sheet on phones, centred card from 600px) at every width, instead of a desktop sidebar: one control set, no duplicated inputs. Rama is a text field with a `<datalist>` of branches seen so far. Rama and Ciudad are sent as `familyBranch` and `city` (T5-BE's query schema; `city` is typed as a local intersection with a `TODO(T5-BE)` until the contract change is on main).
- **Detail:** only fields present in the response are rendered; WhatsApp/Llamar/Correo buttons only when the phone/email is present and makes a safe link. `wa.me` and `tel:` use international digits: a leading `+` is kept as typed, `00` is stripped, and a bare 10-digit number is assumed Mexican (`52`). Anything shorter than 8 or longer than 15 digits gets no link. `mailto:` is refused for addresses with `? & # % /` etc. (no header injection). "Ver en el árbol" when `personId` is set. Focus moves to the person's name when the detail opens.
- **Layout:** phones show the list or the person (with "‹ Directorio"); from 900px the list (20–24rem) sits left and the person right; the profile goes two-column with a sticky avatar card.
- **403:** `FORBIDDEN` with `user.emailVerified === false` shows "Verifica tu correo para ver el directorio" with T1's `ResendVerificationButton` (shared 60 s cooldown). Any other 403 shows "No tienes acceso al directorio". Abort errors render nothing.
- **Expired avatar URLs:** `avatarUrl` is a 1h presigned GET. An image `error` in the profile avatar, the list or the detail refetches that query once (T4's `useExpiredUrlRefetch`, 5 min cooldown, so a broken file can't loop). `AvatarCircle` retries a new `src` by itself.
- **T5-BE alignment:** the PATCH body has only contract keys (the server schema is strict). Phone and text rules come from the contract schemas, so T5-BE's 7–15-digit phone rule and bidi checks apply as soon as its contract change is merged. Confirm 400 `UPLOAD_INVALID` shows the generic avatar failure.
- **No persistence:** the directory is only in the in-memory RTK Query cache (reset on logout, 30 s unused lifetime); nothing in web storage (asserted with a `Storage.prototype.setItem` spy).
- **h1 is "Directorio familiar"**: `features/auth/guards.test.tsx` looks for that heading.

## Requests / contract gaps (→ orchestrator)
1. **Unlisted members (T5-BE).** Done in the contract (WP-2.1). Please make sure `GET /directory/:id` also answers 404 for an unlisted member, not only the list.
2. **Directory `city` on main (T5-BE).** Not on main yet (checked after merging `a8b6995`). The FE already sends `city`; once T5-BE's `directoryQuerySchema` change merges, drop the local `& { city?: string }` in `directory/api.ts` (`TODO(T5-BE)`).
3. **403 code for unverified members (T1/T5-BE, ADR-0001 open item).** FE treats `FORBIDDEN` + `emailVerified === false` as "verify your email". If the server uses another code (e.g. a new `EMAIL_NOT_VERIFIED`), tell me. Please also apply it to `GET /directory/:id`.
4. **Upload helpers (T4).** Done: re-exported from `features/gallery/index.ts` (authorized). Moving them to `shared/lib/` later would be cleaner but isn't needed.
5. **Bucket CORS / signed headers (T5-BE / ops).** Same as WP-T4-FE Requests 3, 4 and 11 for avatar PUTs: CORS `PUT` from the app origin, no browser-forbidden headers in `headers`, `VITE_MEDIA_UPLOAD_ORIGIN` set per environment.
6. **Service worker (T9).** `/api/profile/*` and `/api/directory*` must be `NetworkOnly` (never cached by Workbox) — directory data is PII.
7. **Branch facets (optional, T5-BE).** A small `GET /directory/branches` would let the Rama filter be a real `<select>` instead of suggestions from loaded rows.
8. **Test noise.** Done: `GET /profile/me` and `GET /directory` are in `test/msw.ts` `defaultHandlers`. The remaining "unhandled request" logs in the web suite are `GET /cuencadas/home` and `/cuencadas/2026/media` from other files' own servers (not T5).
9. **Not built:** the wireframe's "Fue a 2026" chip (no attendance filter in the contract) and a member count (Page has no total).

## Verification (2026-10-06)
- `pnpm lint`: 0 diagnostics. `pnpm turbo run typecheck --force`: 6/6.
- `pnpm test`: 100 files, 1088 tests, all passing (web: 50 files, 453). New: `ProfilePage.test.tsx` (18), `profileForm.test.ts` (7), `DirectoryPage.test.tsx` (15), `contactLinks.test.ts` (16). One full run had 5 server DB tests time out at ~35 s under machine load (other agents share the box); they passed on the re-run.
- `pnpm build` OK. Size: **169.59 kB gzip** initial JS (budget 190). Lazy chunks: ProfilePage 5.65 kB, DirectoryPage 4.62 kB gzip.
- **Screenshots** in `docs/ux/screenshots/t5/` at 375 and 1280: `perfil` (with avatar, "Quitar foto" and the directory switch), `directorio` (list) and `directorio-detalle`. Fixtures and screenshots use fictional people only (surname "Ejemplo", branches "Rama Norte/Sur/Costa", `example.com` emails, drawn avatars). 0 px horizontal overflow and 0 elements outside the viewport at 320, 375 and 1280.

## Review log
- 2026-10-06, **WP-0.8c**:
  - "Aparecer en el directorio" help adds "Tus mensajes en el chat seguirán mostrando tu nombre y foto."
  - "Cargar más" that gets a 400 (stale cursor, e.g. after hiding myself) drops the extra pages and reloads page 1.
  - **Phones:** no country code is ever assumed. `+`/`00`/11–15 digits are international (WhatsApp + `tel:+…`); shorter numbers are local (`tel:` as typed, no `wa.me`, note "Este número no tiene código de país…"). Buttons show the number ("WhatsApp +52 …", "Llamar al …"). Request: store E.164 server-side.
  - City filter: prefix suggestions (accent/case-insensitive) from the rows already loaded.
  - Avatar: unmount also aborts the confirm request; no bucket origin → refused before any intent; photos above 2048 px on the long edge are re-encoded as a 2048 px JPEG (q 0.9) first, so 48–200 MP phone photos pass the server's 24 MP cap; the size limit is checked after that. If that resize fails, a photo within 24 MP goes as is; above it the user gets "No pudimos leer esta foto…".
  - 403 states use the shared `classifyAccessDenial` (also `EMAIL_UNVERIFIED`).
  - Screenshot `t5/directorio-telefonos-{375,1280}` (local number, no WhatsApp).
