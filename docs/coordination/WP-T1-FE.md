# WP-T1-FE Auth screens [SEC]
Owner: Frontend · Reviewers: TL, Sec · Branch: wp/t1-fe-auth · PR: # (not opened)

Built on `origin/main` (WP-0.6 merged), against the WP-0.2 contract. The backend (T1-BE) is being built in parallel, so every test uses MSW handlers built from the contract schemas.

## Scope
- **Endpoints** in `features/auth/api.ts` (`injectEndpoints`, `XxxRequest` arg types):
  - `login`, `getMe`, `changePassword`
  - `requestMagicLink` / `consumeMagicLink`
  - `requestPasswordReset` / `confirmPasswordReset`
  - `requestEmailVerification` / `verifyEmail`
  - `inspectInvite` / `acceptInvite`
  - `listSessions`, `revokeSession`, `revokeOtherSessions`
  - the `refreshCurrentUser()` thunk
  - **Logout is not duplicated:** the pages call the WP-0.6 `logout()` thunk.
- **Tags:**
  - `CurrentUser` (`ME`): provided by `getMe`, invalidated by `verifyEmail`
  - `Session` (`LIST` + ids): provided by `listSessions`, invalidated by revoke, revoke-others and change-password
  - `Invite` is unused (only the admin side needs it)
- **Pages** (Spanish copy from `wireframes.md` §3). Each one is lazy and mobile-first, and its forms use `noValidate` with zod-driven errors through `Field`:
  - `/entrar`: email + password, plus "Recibir enlace por correo" (sent to the same email field) and "¿Olvidaste tu contraseña?". After login it sends the user to `redirectPathFromState`, or to `/cambiar-contrasena` when `mustChangePassword` is set. Already-authenticated visitors are redirected away.
  - `/entrar/enlace`: states are consuming, success (then redirect) and invalid/expired (with "Pedir otro enlace").
  - `/invitacion`:
    - inspect, then show the inviter, the expiry and **only** `emailMasked`
    - the form takes name (prefilled from `suggestedDisplayName`), the full email, password and confirmation
    - a live strength meter and the rules are linked through `aria-describedby`
    - accept logs the user in, shows the toast "¡Bienvenida/o a la familia!" and goes home
    - covers invalid, expired, used and missing-token links, plus 409 and 429
  - `/recuperar`: generic confirmation. `/restablecer`: new password + confirmation; on success a toast, then `/entrar`.
  - `/verificar`: consumes the token, shows success, and refetches `/me` when logged in.
  - `/cambiar-contrasena`:
    - **forced:** "Contraseña temporal" field, "Guardar y continuar", and "Cerrar sesión" as the only way out
    - **wrong current password:** WP-0.4 answers 400 `VALIDATION` with a `details` entry on `currentPassword`; that becomes the field error "La contraseña actual no es correcta." (401 `INVALID_CREDENTIALS` is mapped the same way, defensively). Neither logs the user out; only 401 `UNAUTHENTICATED` does
    - **voluntary:** "Contraseña actual" field, and the user returns to `state.from` afterwards
    - `credentialsReceived` (new token, `mustChangePassword: false`) lifts the gate
  - `/perfil/sesiones`:
    - each row shows a device/browser summary from the UA, "Último uso" (relative, with the absolute date in `title`), the opening date and an "Esta sesión" badge. **The IP is not shown** (orchestrator: PII and confusing)
    - "Cerrar" revokes one session
    - "Cerrar las demás sesiones" asks for confirmation in an alertdialog
    - "Cerrar sesión en todos los dispositivos" runs revoke-others, then `logout()`
    - loading and error states, with Reintentar
- **`VerifyEmailBanner`** (`components/VerifyEmailBanner.tsx`): shown for logged-in users with `emailVerified=false`, with "Reenviar enlace" (`POST /auth/email/verify-request`). Mounted in `AppLayout`'s banner slot (see "App-owned changes").
- **Shared pieces:**
  - `AuthLayout`: a single card on cream; at ≥900px it splits 50/50 with the green hero panel and the papel picado edge
  - `PasswordField`: show/hide toggle (`aria-pressed`) plus the strength hint
  - `FormAlert`: an always-mounted `role="alert"` region
  - `forms.ts`: `validateForm`, `describeAuthError`, `passwordStrength`, `usePendingAction` and `useFocusFirstInvalid`
  - `sessionDisplay.ts`: UA summary and relative time

### Security UX [SEC]
- **Sensitive data stays out of the store.** Password and token mutations go through `dispatch(endpoint.initiate(arg, { track: false }))`, so passwords and tokens never sit in `state.api.mutations`. Tests assert `JSON.stringify(store.getState())` contains neither. The pending action is still visible to Redux DevTools, which is dev-only.
- **Fragment tokens are consumed once and then dropped:**
  - They're read with the new `useConsumableFragmentToken()`, a sibling of `useFragmentToken`.
  - A ref guard makes sure StrictMode's double effect can't POST a single-use token twice.
  - `discard()` (which calls `clearFragmentToken` and clears component state) runs after the token is consumed or rejected.
  - Tokens are never put in a query string, never logged and never stored.
- **No account enumeration:**
  - Login shows one fixed message for `INVALID_CREDENTIALS`, whatever the server says.
  - The magic-link and reset confirmations are generic.
  - On a bound invite, `INVITE_INVALID` reads "revisa el correo… si lo es, pide una invitación nueva", so a mismatched email and a dead invite look the same.
- **Redirects:** `redirectPathFromState` / `safeRedirectPath` only. Tests cover `//evil`, `https://evil` and `/\evil`.
- **Feedback:**
  - Submit buttons are disabled while pending, and a ref stops double submits.
  - Errors go to an always-mounted `role="alert"` region, and focus moves to the first invalid field.
  - `isAbortError` shows no message and no toast.
  - 429 always shows "Demasiados intentos. Espera unos minutos y vuelve a intentarlo."
- **Session cleanup:**
  - A reset while logged in dispatches `loggedOut`, because the server revoked every session.
  - `currentUserLoaded` ignores `/me` responses when there's no session or the id differs, so a late response can't revive a session or mix users.

## Interfaces consumed / exposed
- **Consumed:**
  - WP-0.2: auth schemas, `maskEmail`, `PASSWORD_MIN_LENGTH`
  - WP-0.6: `credentialsReceived`, `logout()`, guards, `redirectPathFromState`, the fragment-token stash, `errors.ts`
  - WP-0.7: `Field`, `TextInput`, `Button`, `IconButton`, `Card`, `Badge`, `Dialog`, `EmptyState`, `Skeleton`, `Spinner`, `Toast`
- **Exposed:**
  - `authApi` hooks
  - `refreshCurrentUser()`
  - `VerifyEmailBanner` / `ResendVerificationButton`
  - `useConsumableFragmentToken()`
  - a new **`currentUserLoaded(user)`** reducer in `authSlice` (inside `features/auth`, flagged for TL/Sec): it updates `user` and `passwordChangeRequired` from `GET /me` without touching the token
- **Test helpers** in `features/auth/testing/contractHandlers.ts`:
  - `contractRoute(method, path, inputSchema, respond)` validates the request body with the contract schema and answers 400 `VALIDATION` like the server would
  - `tokenResponse`, `makeInvite` and `makeSession` are `parse`d by the response schemas
  - `apiError` uses `errorHttpStatus`

## Decisions
- **Login layout:** a single form, with password as the primary action and magic link as the secondary button. The wireframe drew Tabs with the link as the default; the brief asked for "email + password with a magic-link option". One shared email field means no tab state and one fewer tap.
- **The `/entrar` h1 is "Entrar"**, not the wireframe's "Entrar a la Cuencada". The app-owned `MorePage.test.tsx` and the guard tests look up that exact heading. The lead line names the Cuencada instead.
- **Invite email:** the wireframe has a read-only prefilled email, but the contract only returns `emailMasked`, so the user types the full address.
  - As a client-side hint, `maskEmail(typed) === emailMasked` is checked before calling the server.
  - The server still makes the real comparison.
- **The invite consent checkbox is omitted.** The wireframe has "☐ Acepto que mis fotos y datos se compartan solo con la familia.", but the contract has no field for it. A consent the server doesn't record can't be audited (see Contract gaps).
- **Magic-link copy:** "Caduca en unos minutos" instead of the wireframe's "15 minutos", because the TTL is server config.
- **Strength meter:** length-based only (12 / 16 / 20), matching the NIST-style policy with no composition rules. It shows "Te faltan N caracteres" below 12.
- **Auth dates** (invite expiry, session dates) use `America/Merida` (`PORTAL_TIME_ZONE`), because no Cuencada is in context. Relative times don't depend on the timezone.
- **"Logout everywhere"** is revoke-others followed by the standard `logout()` (see Contract gaps). If revoke-others fails, the user stays logged in and sees the error, so they can retry.

## App-owned changes (authorized by the orchestrator, separate commit)
1. **`app/AppLayout.tsx`: verify-email banner.** The banner slot renders the status notice and/or `VerifyEmailBanner`. The banner is `React.lazy`-loaded and only rendered when the user is authenticated with `emailVerified === false`, so `authApi` stays out of the initial chunk. It's a 0.65 KB gzip chunk.
2. **No BottomNav on the auth screens.**
   - `shared/lib/featureRoutes.ts` gains `MINIMAL_CHROME` (a route `handle`) and `wantsMinimalChrome(handle)`.
   - `features/auth/routes.tsx` sets the handle on `/entrar`, `/entrar/enlace`, `/invitacion`, `/recuperar`, `/restablecer`, `/verificar` and `/cambiar-contrasena`.
   - `AppLayout` checks `useMatches()` and omits the BottomNav, which also drops its bottom padding. The BottomNav was already hidden at ≥900px.
   - `/perfil/sesiones` keeps it.
   - The wireframe's back button (‹) is not added; I kept the change minimal.
3. **`app/MorePage.tsx`: logout race fixed.**
   - "Cerrar sesión" now navigates to `/` first and dispatches `logout()` from the page's unmount cleanup, so it only runs once the new route has committed (or an error boundary replaced the page).
   - Navigating first and then logging out right away was not enough. RR7 commits navigations in a transition, so a sync `loggedOut` re-rendered the still-mounted `/mas` tree and the guard's `/entrar` redirect won.
   - The test now waits for both the anonymous state and the final location, and checks the location again after the logout settles.
4. **"Más" row renamed** to "Sesiones y seguridad".
5. **Tests:** `AppLayout.test.tsx` covers no BottomNav on each auth route, none during the forced change, and the banner shown or hidden. `MorePage.test.tsx` is updated as described above.

## Contract gaps (→ Architect / T1-BE): resolved by the orchestrator
1. **Logout everywhere:** keep revoke-others + `logout()` for now. T1-BE will add `POST /api/auth/logout-all`; the switch is a **follow-up** for this track.
2. **Wrong current password:** 400 `VALIDATION` with `details[].path === "currentPassword"` (WP-0.4). Implemented and tested.
3. **Invite consent checkbox:** skipped.
4. **Generic invite-invalid state:** kept, so invite state doesn't leak.
5. **`POST /auth/email/verify-request` rate limit:** unspecified. The UI handles 429.
6. **Sessions have no city, and the IP is not shown.** Rows show the device/browser summary + "Último uso" only.

No changes to `packages/types/src/auth.ts`.

## Verification (2026-10-06, after the orchestrator's decisions)
- `pnpm lint`: biome, 0 diagnostics (256 files).
- `pnpm typecheck`: 5/5 tasks succeed.
- `pnpm test`: **4 consecutive full runs green**, each 46 files, 437 passed, 1 todo. The `MorePage` race is fixed.
  - One earlier run, before the final `MorePage` fix, also timed out unrelated tests at 30s while the machine was under heavy load. That didn't recur.
- T1 tests by file:
  - Login (16)
  - Magic link (6)
  - Invite (11)
  - Forgot/Reset (9)
  - Verify (5)
  - Change password (8, including 400 `VALIDATION` on `currentPassword`, a `VALIDATION` error on another field, and 401 `INVALID_CREDENTIALS`, none of which log out)
  - Sessions (7, including "never shows the IP")
  - Banner (4)
  - forms (13)
  - sessionDisplay (9)
  - slice (2 new)
  - fragment pages (updated)
  - AppLayout (+9)
- `pnpm build`: succeeds. `pnpm --filter @cuencada/web size`: the initial JS is **166.89 kB gzip** (budget 190), 519.4 kB raw. Auth code sits in lazy chunks:

  | Chunk | Size (gzip) |
  |---|---|
  | `VerifyEmailBanner` | 0.65 KB |
  | shared `forms` | 2.25 KB |
  | `SessionsPage` | 3.4 KB |
  | `InvitePage` | 2.2 KB |
  | `LoginPage` | 1.5 KB |
  | `ChangePasswordPage` | 1.3 KB |

- **Screenshots** (re-taken) in `docs/ux/screenshots/t1/`: `entrar`, `invitacion` (password typed, so the meter shows), `cambiar-contrasena` (forced) and `sesiones` (no IP), each at 375 and 1280.
  - The auth screens no longer show the BottomNav at 375.
  - Taken with headless Chromium against the Vite dev server, with `/api` proxied to a throwaway stub. Neither the stub nor the temporary config was committed.
  - **Horizontal overflow** is 0 px at 320, 375 and 1280 on all four pages, measured as the max `getBoundingClientRect().right` of every element in `<main>` minus the viewport width.

## Review log
- 2026-10-06, orchestrator decisions:
  - wrong-current-password mapping (400 `VALIDATION` + 401)
  - IP removed from the sessions page
  - Requests 1–4 applied as app-owned changes, in a separate commit
  - contract gaps resolved, with `logout-all` as a follow-up
