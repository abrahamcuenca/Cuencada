# WP-T5-FE Profile & directory [SEC]
Owner: Frontend · Reviewers: TL, Sec · Branch: wp/t5-fe-profile · PR: # (not opened)

Built on `origin/main` (37dd59d) against the WP-0.2 profile contract (`packages/types/src/profile.ts`). T5-BE is parallel, so every test uses MSW. Per the orchestrator's correction, the form follows the **contract**: no birthday and no WhatsApp field (the phone covers WhatsApp). "Aparecer en el directorio" is built against `visibility.listedInDirectory` (migration 0002, WP-2.1); this PR merges after `origin/wp/2.1-migration-0002`.

## Scope
Only `apps/web/src/features/profile/**`, `apps/web/src/features/directory/**`, this doc and `docs/ux/screenshots/t5/`. No edits to `router.tsx`, `store.ts`, `baseApi.ts`, `shared/ui/**` or `packages/types`.

| File | What |
|---|---|
| `profile/api.ts` | `getProfile`, `updateProfile` (PATCH), `createAvatarUpload`, `confirmAvatar`. Writes upsert the cached profile, refetch `/me` (header name/avatar) and invalidate the caller's `Directory` entry and `LIST` |
| `profile/lib/profileForm.ts` | Form values, dirty-field diff (trimmed; blank = empty), PATCH builder validated with `updateProfileInputSchema` (Spanish errors), `listedInDirectory` detection |
| `profile/lib/useAvatarUpload.ts` | Avatar pipeline: client check → object-URL preview → intent → XHR PUT → confirm, with progress |
| `profile/components/AvatarEditor.tsx` | 96px avatar, progress ring, "Cambiar foto", status `<output>`, error `role="alert"` |
| `profile/pages/ProfilePage.tsx` | `/perfil`: avatar card, "Tus datos", "¿Quién puede ver mis datos?" switches, sticky "Guardar cambios" while dirty, "Sesiones y seguridad" link |
| `directory/api.ts` | `listDirectory` (`infiniteQuery` by cursor, 30/page), `getDirectoryEntry`; `keepUnusedDataFor: 30` |
| `directory/lib/filters.ts` | Query builder (`q` from 2 chars, `familyBranch`, `city`), debounce constants, branch suggestions |
| `directory/lib/contactLinks.ts` | `whatsappHref` (`https://wa.me/<digits>`), `telHref`, `mailtoHref` |
| `directory/lib/useDebouncedValue.ts` | Debounce hook |
| `directory/components/*` | List (cards, sentinel + "Cargar más"), detail card, filters sheet, error/403 states |
| `directory/pages/DirectoryPage.tsx` | `/directorio/:userId?` |
| `*/testUtils.ts` | Contract-parsed fixtures and MSW handlers (tests only) |

## Interfaces consumed / exposed
- **Consumed:** `GET/PATCH /profile/me`, `POST /profile/me/avatar/uploads`, `POST /profile/me/avatar/confirm`, `GET /directory`, `GET /directory/:id`; T1's `ResendVerificationButton` and `refreshCurrentUser()`; T4's `putToPresignedUrl` and `isAllowedUploadUrl` (imported by path from `features/gallery/lib/`, see Request 4).
- **Route change:** the directory route is now `/directorio/:userId?` (one route, so opening a person keeps the search, filters and loaded pages). `/directorio` still matches.
- **Tags:** `Profile` `ME`; `Directory` `LIST` and per `userId`.

## Decisions
- **Dirty-field PATCH.** The form stores only the user's edits on top of the server profile. Only fields whose trimmed value differs are sent; a cleared optional field is sent as `null`; a field typed back to its value is not sent. Only dirty fields are validated, so a legacy server value can't block an unrelated save. After a save the edits are dropped and the server's answer becomes the baseline.
- **Privacy switches** (`showEmail`, `showPhone`, `showCity`) are part of the form and saved with "Guardar cambios", each with a Spanish explanation; the section hint says hidden data is also hidden from search. **"Aparecer en el directorio"** is shown only when the profile carries a boolean `visibility.listedInDirectory`, and is then sent as top-level `listedInDirectory` in the PATCH (like `showEmail`). `TODO(WP-2.1)` marks where to switch to the contract type once 0002 is merged.
- **Avatar upload [SEC]** (same guards as T4):
  - `accept="image/jpeg,image/png,image/webp"`; type/size checked with `avatarUploadInputSchema` (Spanish messages) before any request. An empty `File.type` falls back to the extension.
  - The intent is validated with `avatarUploadResponseSchema` and `uploadUrl` must equal `VITE_MEDIA_UPLOAD_ORIGIN` (unset → refused). A refused intent shows "No pudimos subir la foto. Inténtalo otra vez." and nothing is PUT.
  - The PUT sends only the signed headers (forbidden ones like `Content-Length` skipped), `withCredentials = false`, no `Authorization`. The intent is `reset()` from the RTK store right after it's read; the signed URL never reaches the DOM (asserted).
  - The preview object URL is revoked on replace, on success (the server URL takes over), on failure and on unmount. Unmount (navigation, logout) also aborts the intent request and the XHR.
  - Progress: a conic ring around the avatar plus "Subiendo foto… 50 %" in a polite `<output>`.
- **Directory search:** 300 ms debounce, `q` sent only from 2 characters (1 character shows the full list plus "Escribe al menos 2 letras para buscar."). Equivalent queries share one cache entry.
- **Filters** live in the shared `Dialog` (bottom sheet on phones, centred card from 600px) at every width, instead of a desktop sidebar: one control set, no duplicated inputs. Rama is a text field with a `<datalist>` of branches seen so far. Rama and Ciudad are sent as `familyBranch` and `city` (T5-BE's query schema; `city` is typed as a local intersection with a `TODO(T5-BE)` until the contract change is on main).
- **Detail:** only fields present in the response are rendered; WhatsApp/Llamar/Correo buttons only when the phone/email is present and makes a safe link. `wa.me` and `tel:` use international digits: a leading `+` is kept as typed, `00` is stripped, and a bare 10-digit number is assumed Mexican (`52`). Anything shorter than 8 or longer than 15 digits gets no link. `mailto:` is refused for addresses with `? & # % /` etc. (no header injection). "Ver en el árbol" when `personId` is set. Focus moves to the person's name when the detail opens.
- **Layout:** phones show the list or the person (with "‹ Directorio"); from 900px the list (20–24rem) sits left and the person right; the profile goes two-column with a sticky avatar card.
- **403:** `FORBIDDEN` with `user.emailVerified === false` shows "Verifica tu correo para ver el directorio" with T1's `ResendVerificationButton` (shared 60 s cooldown). Any other 403 shows "No tienes acceso al directorio". Abort errors render nothing.
- **Expired avatar URLs:** `avatarUrl` is a 1h presigned GET. An image `error` in the profile avatar, the list or the detail refetches that query once (T4's `useExpiredUrlRefetch`, 5 min cooldown, so a broken file can't loop). `AvatarCircle` retries a new `src` by itself.
- **T5-BE alignment:** the PATCH body has only contract keys (the server schema is strict), plus `listedInDirectory` only when the profile carries it. Phone and text rules come from the contract schemas, so T5-BE's 7–15-digit phone rule and bidi checks apply as soon as its contract change is merged. Confirm 400 `UPLOAD_INVALID` shows the generic avatar failure.
- **No persistence:** the directory is only in the in-memory RTK Query cache (reset on logout, 30 s unused lifetime); nothing in web storage (asserted with a `Storage.prototype.setItem` spy).
- **h1 is "Directorio familiar"**: `features/auth/guards.test.tsx` looks for that heading.

## Requests / contract gaps (→ orchestrator)
1. **`listedInDirectory` (WP-2.1 / T5-BE).** FE expects `OwnProfile.visibility.listedInDirectory: boolean` and `listedInDirectory` as a top-level boolean in `updateProfileInputSchema`; the server must also exclude unlisted members from `GET /directory` **and** `GET /directory/:id` (404). Tell me when to merge `origin/wp/2.1-migration-0002`; I'll drop the optional-field detection.
2. **Directory `city` on main (T5-BE).** The FE already sends `city`; once T5-BE's `directoryQuerySchema` change merges, drop the local `& { city?: string }` in `directory/api.ts`.
3. **403 code for unverified members (T1/T5-BE, ADR-0001 open item).** FE treats `FORBIDDEN` + `emailVerified === false` as "verify your email". If the server uses another code (e.g. a new `EMAIL_NOT_VERIFIED`), tell me. Please also apply it to `GET /directory/:id`.
4. **Export the upload helpers (T4).** Profile/directory import `putToPresignedUrl`/`UploadTransferError`, `isAllowedUploadUrl` and `useExpiredUrlRefetch` from `features/gallery/lib/*` by path. Please re-export them from `features/gallery/index.ts` or move them to `shared/lib/` (no behaviour change).
5. **Bucket CORS / signed headers (T5-BE / ops).** Same as WP-T4-FE Requests 3, 4 and 11 for avatar PUTs: CORS `PUT` from the app origin, no browser-forbidden headers in `headers`, `VITE_MEDIA_UPLOAD_ORIGIN` set per environment.
6. **Service worker (T9).** `/api/profile/*` and `/api/directory*` must be `NetworkOnly` (never cached by Workbox) — directory data is PII.
7. **Branch facets (optional, T5-BE).** A small `GET /directory/branches` would let the Rama filter be a real `<select>` instead of suggestions from loaded rows.
8. **Test noise (WP-0.1, optional).** `guards.test.tsx` and `ChangePasswordPage.test.tsx` now render the real `/directorio` and `/perfil`, so MSW logs "unhandled request" for `GET /directory` and `GET /profile/me`. The tests pass; adding both to `test/msw.ts` `defaultHandlers` would silence it.
9. **Not built:** "Quitar foto" (`DELETE /profile/me/avatar` exists in the contract), the wireframe's "Fue a 2026" chip (no attendance filter in the contract) and a member count (Page has no total).

## Verification (2026-10-06)
- `pnpm lint`: 0 diagnostics. `pnpm turbo run typecheck --force`: 6/6.
- `pnpm test`: 81 files, 817 tests, all passing; new: `ProfilePage.test.tsx` (17), `profileForm.test.ts` (7), `DirectoryPage.test.tsx` (15), `contactLinks.test.ts` (16). `MorePage.pendingNavigation.test.tsx` (not touched) timed out once under machine load in an earlier run and passes alone.
- `pnpm build` OK. Size: **169.46 kB gzip** initial JS (budget 190). Lazy chunks: ProfilePage 5.5 kB, DirectoryPage 4.6 kB gzip.
- **Screenshots** in `docs/ux/screenshots/t5/` at 375 and 1280: `perfil` (with avatar, today's contract), `perfil-directorio` (with `listedInDirectory`), `directorio` (list) and `directorio-detalle`. 0 px horizontal overflow and 0 elements outside the viewport at 320, 375 and 1280.
