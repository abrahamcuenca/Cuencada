# WP-T6-FE Family tree [SEC]
Owner: Frontend · Reviewers: TL, Sec · Branch: wp/t6-fe-family · PR: # (not opened)

Built against the WP-0.2 contract (`packages/types/src/family.ts`) with MSW. T6-BE was built in parallel; its notes (self-edit via `PATCH /family/me`, `depth` clamped to 3, `extended.relationships` carrying edge ids, 409/400/404 on relationship writes, `avatarUrl` null until T5) are reflected below.

## Scope
- **`/arbol/:personId?`** (member, lazy): a person-centred view with no tree library.
  - Focus card in the middle: avatar (gold ring), name, «apodo», years (`n. 1952`, `1921 – 1998`, `† 1999`), «Rama …», and "Sin cuenta" for people without an account.
  - **Padres** above, joined to the card by an inline-SVG connector. **Pareja/Parejas** sit under the card on phones (dashed link) and beside it at ≥900px. **Hijos** are below, with a split connector. **Hermanos** are in a horizontal strip that scrolls inside its own container.
  - Connector columns match the band grid (at most 3 columns, `vector-effect: non-scaling-stroke`), so the lines stay 2px and aligned at 320–1280px. Every SVG is `aria-hidden`.
  - **Tapping anyone re-centres** with `navigate('/arbol/:id', { state: { trail } })`, so the URL updates and Back works. The breadcrumb ("Personas visitadas", up to 5 entries) lives in history state: it is validated on read, comes back correctly on Back, and is cut short when you return to someone already in it (so it never loops).
  - After a re-centre, keyboard focus moves to the new person's `h2` and it scrolls into view.
  - The transition is a 400ms fade/lift keyed by the person. `usePrefersReducedMotion()` swaps in the `reducedMotion` class (`data-motion="reduced"`), and a CSS media query guards it as well.
  - **"Ver más: abuelos y nietos"** (`aria-expanded`) refetches with `depth=2` and derives grandparents and grandchildren from `extended.relationships`.
  - **Search:** debounced (300ms, at least 2 characters), up to 8 results as buttons, a polite live-region count, and the box clears after a jump.
  - **States:**
    - per-group empty text ("Aún no hay padres registrados.", etc.)
    - 403 `FORBIDDEN` shows "Verifica tu correo para ver el árbol familiar"
    - 404 without `personId` shows "Aún no estás en el árbol" with the search box
    - 404, or a malformed id (checked client-side with `idSchema`, so no request is sent), shows "No encontramos a esa persona"
    - any other error shows Reintentar
- **Self-edit:** on my own node (`user.personId === focus.id`, or a matching `userId`), "Editar mis datos" opens a lazily loaded Dialog with only Apodo, Rama familiar and Año de nacimiento. It sends only the changed fields, validated with `selfEditPersonInputSchema`, to `PATCH /family/me`.
- **Admins** also see "Editar en administración" on any node.
- **Admin `/admin/familia`** and **`/admin/familia/:personId`** are lazy, in `familyRoutes.admin`. They rank above T8's `/admin/*`.
  - **List:** people with a debounced search, "Cargar más" by cursor, and "Con cuenta"/"Sin cuenta" badges.
  - **Create/edit form:** nombre, apodo, rama, nacimiento, fallecimiento, "Ya falleció", and the linked account. A death year implies `deceased`. Edits send only the changed fields. 409 on `userId` shows "Esa cuenta ya está vinculada a otra persona."
  - **Linking an account:** search `GET /admin/users?q=`; accounts already linked to another person are disabled.
  - **Relationships:** Padres, Parejas and Hijos groups with "Agregar padre/madre", "Agregar pareja" and "Agregar hijo/a". Each opens a Dialog picker (people search, already-related people disabled).
    - "Agregar padre/madre" is disabled at 2 parents.
    - Server refusals are shown in Spanish inside the picker: the server's message or detail for 409 and 400, a fixed message for 404, and a fallback that names the rules when the body isn't a contract envelope.
    - "Quitar" asks for confirmation in an `alertdialog`, then sends `DELETE /admin/relationships/:id`. Edge ids come from `extended.relationships` in the depth-1 view.
  - **Delete person:** behind an `alertdialog`.
- **Accessibility:** each group is a `section` labelled by its `h2` ("Padres", "Parejas", "Hijos", "Hermanos", "Abuelos", "Nietos") and holds a `ul` of buttons with spoken names ("Ver a Pablo Herrera Navarro, ya falleció"). The "†" is visual. Targets are at least 44px.

## Files
- **Member side:** `features/family/`
  - `api.ts`
  - `routes.tsx`
  - `family.module.css`
  - `pages/FamilyTreePage.tsx`
  - `components/{TreeParts,PersonSearch,SelfEditDialog}.tsx`
  - `lib/{tree,forms,hooks}.ts`
  - `testing/fixtures.ts` (in-memory graph, view builder, MSW handlers)
- **Admin side:** `features/family/admin/`
  - `api.ts`
  - `admin.module.css`
  - `pages/{AdminFamilyPage,AdminPersonPage}.tsx`
  - `components/{PersonForm,UserLinkField,RelationshipManager,ConfirmDialog}.tsx`
- **Tests:**
  - `pages/FamilyTreePage.test.tsx` (15)
  - `admin/AdminFamily.test.tsx` (8)
  - `lib/tree.test.ts` (11)
- **Screenshots:** `docs/ux/screenshots/t6/`

No files outside `features/family/**` and docs were edited.

Fixtures use fictional people only (public repo). Tests, the screenshot stub and the screenshots use invented names (e.g. "José Herrera Navarro" «Pepe», "Ana Morales Vega") and initials-only avatars: no real family names, photos or relationships.

## Verification (2026-10-06)
- `pnpm lint`: clean.
- `pnpm turbo run typecheck --force`: 6/6 tasks pass.
- `pnpm test`: 80 files, 796 tests pass.
- `pnpm build`: succeeds. `pnpm --filter @cuencada/web size`: initial JS is **169.57 kB gzip** (budget 190), with no family code in it.
- Lazy chunks (gzip):

  | Chunk | Size |
  |---|---|
  | `FamilyTreePage` | 3.52 kB |
  | `PersonSearch` | 1.01 kB |
  | `SelfEditDialog` (loaded only when opened) | 1.18 kB |
  | `AdminFamilyPage` | 1.84 kB |
  | `AdminPersonPage` | 3.04 kB |

- Images are lazy (`AvatarCircle` uses `loading="lazy"` and `decoding="async"`). Re-centring keeps the previous view on screen until the new one arrives (`aria-busy`), so there is no skeleton flash or layout jump.
- **Screenshots:** `tree`, `tree-mas` (Ver más), `search`, `admin-list` and `admin-person`, each at 375 and 1280.
  - Taken with headless Chromium against the Vite dev server and a stub API serving the rich fixture: 2 parents, a partner, 3 children, 4 siblings and 2+2 extended relatives.
  - Page horizontal overflow is **0 px** for all five screens at 320, 375 and 1280.
  - At 320 and 375 the sibling strip overflows inside its own container (`scrollWidth > clientWidth`), never the page.
  - Full-page captures show the fixed BottomNav part-way down the image; that's an artefact of the capture.

## Requests
1. **T8 (admin shell):** add a "Personas y árbol" card/link to `/admin/familia` on the admin landing page. I can't edit `features/admin/**`.
2. **T8:** `searchUsersForPersonLink` (`GET /admin/users`) is injected under a feature-specific name. Once T8 ships its users list endpoint, we can share one hook.
3. **T6-BE / contract:** `PersonSummary` has no years, so relatives show "†" but not their years. Only the focus card shows years. If years should appear on every card, add `birthYear`/`deathYear` to `PersonSummary`, with the same privacy rule the BE already applies.
4. **T6-BE / contract:** the task asked for `notes` and an optional photo per person. Neither is in `createPersonInputSchema`, so neither is built. They need a contract amendment, plus the T5/T4 upload flow for the photo.
5. **T6-BE:** please keep Spanish `message`s on 409s that tell the cases apart (cycle / tercer padre / duplicado / pareja repetida). The UI shows them verbatim. The 400 self-link is caught client-side as well.
6. **T1/T5 (ADR 0001 open item):** the UI treats any 403 `FORBIDDEN` from `/family/tree` as "verify your email". If the server ever returns 403 for another reason, a distinct code (e.g. `EMAIL_UNVERIFIED`) would avoid the wrong message.
7. **WP-0.7:** the screen would benefit from a shared `PersonChip` and a horizontal-scroll strip primitive; both are local to the family feature for now.

## Review log
