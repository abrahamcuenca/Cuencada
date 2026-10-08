# WP-4.7 Profile entry points: account menu and contextual "Editar mi perfil"
Owner: Senior JS Frontend (with UI/UX) · Branch: `wp/4.7-profile-entry` · PR: # (not opened)

Based on `origin/main` (`2d39ec3`, WP-4.6 merged). Web only: no contract, server or migration changes.

## Why
From the owner: "I don't see a way to edit my user profile to update my contact info." At ≥900 px the TopNav had no link to `/perfil`, only a bare "Salir". On phones the only path was Más → Mi perfil, and nothing in the directory, the tree or Home pointed there.

## Scope
### 1. TopNav account menu (`apps/web/src/app/AccountMenu.tsx`, `accountMenu.module.css`)
- For members and admins, "Salir" is replaced by an account button: the avatar (`AvatarCircle` sm, photo or initials) and the first word of `displayName`, plus a caret. Accessible name: **"Mi cuenta: {nombre}"** (`aria-label`; the visible first name is in it, so label-in-name holds). Below 480 px only the avatar shows. The button is 44 px tall and at least 44 px wide.
- Disclosure pattern: `<button aria-expanded aria-controls>` plus a `<ul>` of links (not `role="menu"`, so screen readers keep their normal link navigation). Entries, each 44 px tall:
  - Mi perfil → `/perfil`
  - Contacto → `/perfil#contacto`
  - Sesiones y seguridad → `/perfil/sesiones`
  - Panel → `/admin` (admins only)
  - Cerrar sesión (danger tone, below a divider)
- Keyboard: Enter/Space toggle. ArrowDown/ArrowUp on the button open the menu on the first/last entry. Inside, ArrowDown/ArrowUp wrap, and Home/End jump. Escape closes and returns focus to the button. Tab past the last entry closes it.
- It also closes on a click/tap outside (`pointerdown`), on any navigation (`location.key`), and after choosing an entry. A press inside the menu never closes it before the click lands (Safari blurs the button on press without focusing the link).
- During a forced password change the menu offers only "Cerrar sesión": every other page would bounce back to `/cambiar-contrasena`.
- While the session restores (`pending`), the header action is still empty. Anonymous visitors keep "Entrar" (hidden on the login screens, as before).
- "Cerrar sesión" does what "Salir" did: `dispatch(logout())`.
- The button shows at every width (it replaces "Salir", which also showed on phones), so phones gain the same shortcut next to Más.

### 2. Mobile Más (`app/MorePage.tsx`)
A separate **Contacto** row (📇 → `/perfil#contacto`) right after Mi perfil.

### 3. `/perfil#contacto` (`features/profile`)
- `paths.ts`: `PROFILE_PATH`, `CONTACT_SECTION_ID = "contacto"`, `PROFILE_CONTACT_PATH`. It is a tiny module, so importing it never pulls the profile page or its API into another chunk.
- `ContactSection`'s form has `id="contacto"`. Its "Contacto" `h2` is `tabIndex={-1}` with `data-section-heading`, and `scroll-margin-top` clears the sticky TopNav.
- `lib/useScrollToSection.ts`: once the profile has loaded, it scrolls to the fragment's section and focuses its heading. It runs again on every navigation (`location.key`), so "Contacto" works while already on `/perfil`. Only whitelisted ids are used, and a malformed `%` fragment is ignored.

### 4. Contextual links
- **Directorio** (`DirectoryPage`, `DirectoryList`, `DirectoryDetail`):
  - A compact banner under the title: "¿Cambió tu foto, tu teléfono o tus redes? Actualízalos en tu perfil." with **Editar mi perfil** → `/perfil`. It is always shown to the member, because their own row may be pages away or hidden ("Aparecer en el directorio" off).
  - The member's own row reads "{nombre} (tú)".
  - Their own card gets an **Editar mi perfil** button.
- **Árbol** (`FamilyTreePage`): on the user's own person (`isMine`), **Editar mi contacto** → `/perfil#contacto` sits next to "Editar mis datos". It shows even when `canEdit` is false, because linking to one's own profile needs no tree permission. Contacts live in the profile, not the tree person, which is why this is a link and not a dialog.
- **Home** (`features/profile/components/CompleteProfileCard.tsx`, rendered by `HomePage` after the hero):
  - For a logged-in member (not during a forced password change) whose profile has **no avatar and no contact**, a small dismissible card: "Completa tu perfil: foto y contacto" + **Completar perfil** → `/perfil`.
  - "No contact" (`lib/completeness.ts` `needsProfileCompletion`): no phone and no WhatsApp/Instagram/Facebook/TikTok/LinkedIn/GitHub/website. The account email doesn't count, since every member has one.
  - A `/me` user with an `avatarUrl` never triggers `GET /profile/me`.
  - Closing it writes `cuencada-profile-prompt-dismissed:{userId}` = `"1"` to localStorage, inside try/catch. With storage blocked it closes for the visit only.

## Decisions
1. **"Panel" moved from the TopNav links into the account menu** (the brief said to avoid duplicates). With the avatar and first name, an admin's bar would have needed about 920 px for six links plus the account button, which is more than the 900 px breakpoint. Admins now see the same five links as members, and Panel is one click away in the menu. `/mas` keeps "Panel de administración". The `ADMIN_NAV_LABEL` export is gone (no other users).
2. **Disclosure, not ARIA menu.** The entries are navigation links plus one action, so a list of links behind `aria-expanded` is the simpler and better-supported pattern. Arrow keys are added as a convenience; Tab works as usual.
3. **Account button on phones too.** The old "Salir" button was already in the phone header, and keeping one header action at every width avoids a layout switch. At 320 px it is the avatar only.
4. **The directory banner is always shown**, not only when the member is listed. The client cannot cheaply tell whether the member is listed without paging, and the copy works both ways.
5. **localStorage key holds the user id** (an opaque UUID, not PII). This follows the precedent of the install card's dismissal (`features/pwa/install.ts`). No profile data is stored.

## Security / privacy
UX only: `/perfil` and every `/profile/me*` route act on the caller, whatever the client shows. "Panel" in the menu is a hint, and the server enforces the admin role. The fragment is whitelisted before `getElementById`. No new storage of PII. The Home card reads the caller's own profile, which they can already see on `/perfil`.

## Tests
- Web (Vitest + RTL):
  - `app/AccountMenu.test.tsx`: open/close, first name + initials, Escape returns focus, click outside, Tab out, arrow/Home/End keys, Contacto → `/perfil#contacto` closes the menu, admin Panel once, Cerrar sesión logs out and shows Entrar, forced change offers only Cerrar sesión; `firstName`.
  - `AppLayout.test.tsx`: the menu replaces Salir; admins have no Panel link in the bar and exactly one in the menu. It now uses `createTestServer`.
  - `MorePage.test.tsx`: the Contacto row.
  - `profile/pages/ProfilePage.contacto.test.tsx`: scrolls to `#contacto` and focuses its heading after load; runs again on a same-page navigation; ignores unknown or malformed fragments.
  - `profile/lib/completeness.test.ts`.
  - `cuencadas/pages/HomePage.profilePrompt.test.tsx`: shown, hidden for a phone/network/photo, no request when `/me` has an avatar, anonymous, dismiss persisted per user, other user still sees it, blocked storage.
  - `directory/pages/DirectoryPage.test.tsx`: banner, "(tú)" row, own card's button, none on others' cards.
  - `family/pages/FamilyEditing.test.tsx`: Editar mi contacto on my node only.
  - `HomePage.test.tsx` and `HomePage.highlights.test.tsx` gained a `/profile/me` handler.
- E2E:
  - `nav.spec.ts` 11c: the admin bar equals the member's, and Panel is reached through the account menu.
  - New 11d `@desktop`: desktop-1280 opens the menu, checks Escape/focus/ArrowDown, follows Contacto to `/perfil#contacto` with the heading in the viewport and focused. Phones go Más → Mi perfil, then Más → Contacto. Both then check Directorio → Editar mi perfil → `/perfil`.
  - `quality.spec.ts` gained `perfil-contacto` and `menu-cuenta` (menu open) at 320/375 + axe.
  - Every `"Salir"` check (`support/fixtures.ts` `login`, `auth`, `chat`, `mergePeople`) now looks for the account button `/^Mi cuenta/`.

## Screenshots
`docs/ux/screenshots/nav/`:
- `account-menu-{375,1280}.webp` (menu open)
- `directorio-editar-perfil-{375,1280}.webp`
- `admin-{375,1280}.webp` and `member-…`/`anonymous-…`/`restricted-…` refreshed with the new header

All use the fictional e2e cast, from `E2E_UPDATE_DOCS=1` runs of `nav.spec.ts`.

## Verification (2026-10-08)
On `origin/main` `2d39ec3` (re-fetched before finishing: no newer commits, so the merge was a no-op):
- `pnpm lint`: clean.
- `pnpm turbo run typecheck --force`: 6/6 tasks.
- `pnpm test`: 189 files, 2476 tests.
- `pnpm build`: ok. Initial JS is 179.79 kB gzip (budget 190).
- `pnpm typecheck:e2e`: ok.
- `pnpm e2e` on isolated ports 3770/3771/4770 with DB `cuencada_w47_e2e`: 73 passed (journeys on iphone-13, pixel-7 and desktop-1280, plus the 320/375 + axe gates including the new `perfil-contacto` and `menu-cuenta`). Lighthouse passed 1/1.
- Screenshots: `E2E_UPDATE_DOCS=1` run of `nav.spec.ts` on iphone-13 and desktop-1280 (8 passed).
