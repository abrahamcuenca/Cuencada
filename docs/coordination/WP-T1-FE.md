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
    - **voluntary:** "Contraseña actual" field, and the user returns to `state.from` afterwards
    - `credentialsReceived` (new token, `mustChangePassword: false`) lifts the gate
  - `/perfil/sesiones`:
    - each row shows a device/browser summary from the UA, the relative last activity (with the absolute date in `title`), the IP, the opening date and an "Esta sesión" badge
    - "Cerrar" revokes one session
    - "Cerrar las demás sesiones" asks for confirmation in an alertdialog
    - "Cerrar sesión en todos los dispositivos" runs revoke-others, then `logout()`
    - loading and error states, with Reintentar
- **`VerifyEmailBanner`** (`components/VerifyEmailBanner.tsx`): shown for logged-in users with `emailVerified=false`, with "Reenviar enlace" (`POST /auth/email/verify-request`). **It isn't mounted yet**; see Requests.
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

## Requests (outside my folders, → orchestrator)
1. **Mount `VerifyEmailBanner` in `AppLayout`'s banner slot** (WP-0.6, `app/AppLayout.tsx`). For example: `banner={showBanner ? <StatusBanner /> : <VerifyEmailBanner />}`, or render both stacked. It renders `null` unless the user is authenticated and unverified. To keep it out of the initial chunk, it could be lazy-loaded or the slot could accept it as is; it's about 1 KB.
2. **Auth screens without BottomNav under 900px** (wireframes §3: "no BottomNav, only a back (‹)"). That's an `AppLayout` concern. For example, a route `handle: { chrome: "minimal" }` read by the layout. Today the auth pages render inside the normal shell.
3. **Flaky `app/MorePage.test.tsx` › "logs out and goes home from Cerrar sesión"** (pre-existing race, app-owned):
   - `MorePage` dispatches `logout()` and navigates to `/` when the POST resolves.
   - `RequireAuth`'s `<Navigate to="/entrar">` effect sometimes runs after that navigation and wins.
   - It failed in 2 of 4 full-suite runs here and passes alone.
   - Suggested fix: navigate to `/` (or `/entrar`) **before** dispatching `logout()`, or have the test accept `/entrar`.
4. **`MorePage` "Sesiones" row label:** the wireframe says "🔐 Sesiones y seguridad". Optional.

## Contract gaps (→ Architect / T1-BE)
1. **No single "logout everywhere" endpoint.** It's composed from `POST /auth/sessions/revoke-others` + `POST /auth/logout`. That's fine, but it isn't atomic: if the second call fails, the pending-logout marker from WP-0.6 covers it.
2. **Wrong current password on change-password.** The contract doesn't say which code it returns. The UI assumes 401 `INVALID_CREDENTIALS` and shows a field error. **It must not be 401 `UNAUTHENTICATED`**, which the base query treats as a revoked session and logs the user out.
3. **Invite consent:** there's no `consent` / `acceptedTermsAt` on `inviteAcceptInputSchema`. If the family wants the wireframe's checkbox to mean anything, the server has to record it.
4. **`InviteInspectResponse` has no `kind`** for expired vs. used vs. revoked. This is deliberately generic, and the UI shows one message.
5. **`POST /auth/email/verify-request` rate limiting** isn't specified. The UI handles 429.
6. **`SessionListItem` has no location.** The wireframe's "Mérida · hace 2 min" would need GeoIP on the server; the UI shows the IP instead.

No changes to `packages/types/src/auth.ts`.

## Verification (2026-10-06)
- `pnpm lint`: biome, 0 diagnostics (256 files).
- `pnpm typecheck`: 5/5 tasks succeed.
- `pnpm test`: 46 files, 425 passed, 1 todo (final run all green). The one failure seen in some runs is the pre-existing `MorePage` race (Request 3). The web project alone has 30 files and 223 tests, all passing in 2 consecutive runs. The T1 tests:
  - Login (16)
  - Magic link (6)
  - Invite (11)
  - Forgot/Reset (9)
  - Verify (5)
  - Change password (6)
  - Sessions (6)
  - Banner (4)
  - forms (13)
  - sessionDisplay (9)
  - slice (2 new)
  - fragment pages (updated)
- `pnpm build`: succeeds. `pnpm --filter @cuencada/web size`: the initial JS is **166.65 kB gzip** (budget 190), 518.6 kB raw. Auth code sits in lazy chunks:

  | Chunk | Size (gzip) |
  |---|---|
  | shared `forms` | 2.25 KB |
  | `SessionsPage` | 3.40 KB |
  | `InvitePage` | 2.19 KB |
  | `LoginPage` | 1.48 KB |
  | `ChangePasswordPage` | 1.24 KB |

- **Screenshots** in `docs/ux/screenshots/t1/`: `entrar`, `invitacion` (with a password typed, to show the meter), `cambiar-contrasena` (forced) and `sesiones`, each at 375 and 1280.
  - Taken with headless Chromium against the Vite dev server, with `/api` proxied to a throwaway stub. Neither the stub nor the temporary config was committed.
  - **Horizontal overflow** is 0 px at 320, 375 and 1280 on all four pages, measured as the max `getBoundingClientRect().right` of every element in `<main>` minus the viewport width.
  - In the 375 full-page shots the fixed BottomNav appears mid-page. That's a capture artifact: the page reserves padding for it.

## Review log
