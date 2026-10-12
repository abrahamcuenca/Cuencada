# WP-7 Two-step verification (TOTP) [SEC]
Owner: Senior full-stack JS (auth/security) with UI/UX · Branch: `wp/7-two-factor` · PR: (not opened)

Based on `origin/main` @ 2304d99 (latest migration 0010). Rules: ADR 0001 §3 (auth) and **§9** (this WP, binding). **Owner decisions:** opt-in for members, **mandatory for admins**; trusted devices for members only (30 days), admins enter a code on every login; lost phone and codes → an admin resets a member (audited, emailed), and an admin's reset needs **another** admin (never self).

## Libraries
| Package | Version | License | Why |
|---|---|---|---|
| `otplib` | 13.5.0 (2026-08-21, older than the 7-day `minimumReleaseAge`) | MIT | The maintained RFC 4226/6238 implementation; v13's functional API (`generateSecret`, `generateURI`, `verify` with `epochTolerance` and `afterTimeStep` for replay prevention) and constant-time comparison. Pulls `@otplib/*` 13.5.0 plus `@noble/hashes` and `@scure/base` (MIT, audited, no native code). No `@otplib/preset-default` in v13: the `otplib` package is the preset. |
| `uqr` | 0.1.3 | MIT | QR code as an SVG string **server-side**, zero dependencies (a port of Project Nayuki's generator). Returned as a `data:image/svg+xml` URI, which the CSP already allows (`img-src data:`), so the browser makes no external request and the client bundle carries no QR library. `qrcode` was rejected: it drags `yargs`/`pngjs` into the server for a CLI we do not use. |

`pnpm audit` after the change: see "Verification".

## What shipped
### Data (`0011_two_factor`, expand-only)
- `user_totp` (`user_id` PK/CASCADE, `secret_ciphertext`/`secret_iv`/`secret_tag` base64, `enabled_at` null = pending, `last_used_step` bigint ≥ 0, timestamps).
- `user_recovery_codes` (`code_hash` SHA-256, unique per user, `used_at`).
- `trusted_devices` (`token_hash` unique, `user_agent_label` ≤ 80, `expires_at`, `last_used_at`, `revoked_at`).
- `two_factor_challenges` (`token_hash` unique, `purpose` = `login`, `method` = `password` | `magic_link`, `expires_at`, `attempts` 0–5, `consumed_at`).
- `sessions.two_factor_verified_at` (nullable): the gate's source of truth.
- Upgrade test: `migrations.test.ts` "migration 0011". Cleanup job purges old challenges and dead trusted devices.

### Config
`TOTP_ENCRYPTION_KEY` (32 bytes, hex or base64): `config.ts` (credential-capable like every key), `infra/project.yml` `server.credentials` → `vault_cuencada_totp_encryption_key`, the preflight's secret list (and a valid dummy), the runbook's vault table and rotation notes, `.env.example` (the public dev placeholder, also the non-production default). Production refuses missing, malformed, low-entropy (< 16 distinct bytes) and placeholder keys.

### Server
| Route | Auth | Notes |
|---|---|---|
| `POST /api/auth/login`, `POST /api/auth/magic-link/consume` | public | `LoginResponse`: a session, or a `TwoFactorChallenge` (no session) for users with 2FA unless a member's trusted-device cookie is valid |
| `POST /api/auth/2fa/verify` | public | challenge + `code`/`recoveryCode` (+ `trustDevice`, ignored for admins) → session; 5 attempts then burned; 20/IP and 10/user per 15 min |
| `GET /api/auth/2fa/status` | user, `allowPendingTwoFactor` | enabled, required (admin), codes left, session verified, trust allowed |
| `POST /api/auth/2fa/setup` | user, `allowPendingTwoFactor` | re-auth (password or a login < 10 min old) → pending secret, otpauth URI, QR SVG data URI, manual key; `no-store` |
| `POST /api/auth/2fa/enable` | user, `allowPendingTwoFactor` | first code → enabled, 10 recovery codes once, other sessions and devices revoked, this session verified, access token re-issued; email |
| `POST /api/auth/2fa/recovery-codes` | user | password + code → new codes |
| `POST /api/auth/2fa/disable` | user | password + code or recovery code; 403 for admins; email |
| `GET /api/auth/2fa/trusted-devices`, `DELETE …/:id` | user | own devices only (404 otherwise), `current` marks this browser |
| `POST /api/admin/users/:id/2fa/reset` | admin | not self (403), 409 without 2FA; secret/codes/devices deleted, sessions revoked, audited, admins alerted (target admin), target emailed |

- Files: `lib/totp.ts` (otplib + AES-GCM + QR + recovery codes), `modules/auth/twoFactor.ts` (service: login gate, checks with row locks, devices, codes, notices), `modules/auth/twoFactorRoutes.ts`; changes in `plugins/auth.ts` (gate), `sessionRoutes.ts`, `emailRoutes.ts`, `passwordRoutes.ts` (carry the session's verification, revoke trusted devices), `currentUser.ts` (`amr`, new `CurrentUser` fields, `issueAccessResponse`), `admin/userRoutes.ts` (reset, promotion), `admin/users.ts` (`twoFactorEnabled`), `adminAlerts.ts` (cap-exempt `two_factor_reset`), `mailBudget.ts` (notices counted), `lib/rateLimit.ts` (`keyedRateLimit`).
- Emails (`packages/emails`): `two-factor-notice` (enabled, disabled, reset by an admin, recovery code used), and `AdminAccountChange.TwoFactorReset` in the admin alert.

### Web (all new UI lazy)
- **Login and magic link:** after a challenge, the code step (`TwoFactorChallengeStep`, its own chunk): `autocomplete="one-time-code"`, `inputmode="numeric"`, "Usar un código de recuperación", "Confiar en este dispositivo 30 días" (hidden when `trustDeviceAllowed` is false), "Volver a iniciar sesión" when the challenge is gone. The challenge token lives in component state only.
- **Sesiones y seguridad** (`/perfil/sesiones`): "Verificación en dos pasos" (`TwoFactorSettings`, lazy): status badge, "Activar" (wizard in a sheet: contraseña → QR + clave → código → 10 códigos with "Copiar códigos", "Descargar como texto" via a Blob URL, "Ya los guardé"), "Generar códigos de recuperación nuevos", "Desactivar" (members; admins read why not), "Dispositivos de confianza" with "Quitar".
- **Admin gate:** `RequireTwoFactorEnrolled` (inside `RequirePasswordChanged`) and the 403 handler send an admin to `/activar-verificacion` ("Por seguridad, los administradores deben activar la verificación en dos pasos"), which runs the same wizard and continues to `/admin`.
- **Panel → Usuarios:** badges "2 pasos" / "Sin 2 pasos" (admins), and in the user sheet "Restablecer verificación en dos pasos" (confirm sheet; not on yourself).
- Initial JS: **183.03 kB** gzip (budget 190; was 182.7). Only the gate (slice flag, guard, route entry, error code) is in the initial chunk; the step, wizard, settings and API live in lazy chunks.

## Decisions
1. **The gate trusts the database, not the JWT.** `amr` is added to the access token (and re-issued after enable) for the client, but the guard reads `sessions.two_factor_verified_at`, like role and must-change. A forged or stale claim changes nothing.
2. **Order of gates:** temporary password first, then two-step enrollment. The seed admin changes the password, then enrolls; change-password keeps the old session's verification so a verified admin is not sent back to the gate.
3. **Pre-WP-7 sessions are unverified.** Existing admins must enroll on their next request (runbook "Next deploy notes"); members are unaffected.
4. **Promotion:** a member with 2FA who is promoted loses every session and trusted device (they might have skipped the code through a device); one without 2FA keeps the session and is gated. A promoted admin with 2FA and an unverified session sees "Vuelve a entrar con tu código" on the gate page.
5. **Re-auth for setup:** the current password, or a session started less than 10 minutes ago (`TWO_FACTOR_FRESH_LOGIN_MINUTES`). The web always asks for the password.
6. **Recovery codes: 80-bit + SHA-256**, not argon2: the entropy makes offline guessing infeasible and the single lookup keeps verify cheap; shown `xxxx-xxxx-xxxx-xxxx`, case and dashes ignored.
7. **Error codes:** two new top-level `ErrorCode`s (`TWO_FACTOR_SETUP_REQUIRED` 403, `TWO_FACTOR_INVALID` 400) as the task names them; a wrong code is 400 (not 401) so the web never tries to refresh; an unusable challenge reuses `TOKEN_INVALID`.
8. **Session revocation reasons:** no new `revoked_reason` value (that would need a CHECK change): enable/disable use `revoke_others`, the admin reset and promotion use `admin_revoked`.
9. **Per-user limiter in memory** (like the login limits): 10 checks per user per 15 min across challenges and IPs (`keyedRateLimit`, keyed after looking up the challenge's owner).
10. **Mail budget:** the four notices are security notices: reserved tier of the daily cap, one count per audit row (like password-changed). The admin reset of an admin is a cap-exempt admin alert.
11. **Audit action names** follow the task (`auth.2fa_verified`, …): `auditActionSchema` now allows a digit at the start of a later segment.
12. **Key rotation:** no key id or second key slot in this WP; the runbook says never to replace the key alone and describes re-encryption (a script is a backlog item).
13. **Magic-link-only members** (no password) cannot pass the password re-authentication of disable and regenerate, so they cannot turn 2FA off or get new codes themselves; only an admin reset helps (fail-safe). Backlog: a "set a password" path.
14. **Security review of PR #61:** L1 — the e2e TOTP helper reaches the database only through the harness guard (`resolveE2eDatabase(...).url`, the test-cluster catalog marker, `current_database()`). L2 — change-password, password reset (confirm) and the admin forced reset burn the user's open login challenges in the same transaction; `twoFactorRoutes.test.ts` "password changes burn open challenges" covers all three.

## Tests
- `lib/totp.test.ts`: window ±1 (and not ±2), replay at and below the last step, malformed codes, AES-GCM (fresh nonce, never the secret in clear, wrong key / other user / tampered tag fail closed, no secret in errors), URI, QR, recovery codes.
- `modules/auth/twoFactorRoutes.test.ts` (real Postgres, `inject()`): challenge instead of a session (hashed token, no cookie, no session row), verify → `amr`, single-use challenge; magic link gated; replay across challenges; attempts, burn and generic errors; expiry (5 min); per-user and per-IP limits; unknown challenge; trusted devices (cookie flags, hashed, label, bound to user, 30-day expiry, revocation, `current`, never for admins); recovery codes (hashed, single-use, email, audit); enrollment (re-auth, encrypted pending secret, wrong code, other sessions closed, email, 409 when enabled, status); regenerate; disable (member yes, admin 403); the admin gate (allowlist, `/me` flags, enrollment unlocks, old token works, seed-admin order, verified admin across a password change, forged claim, promotion); admin reset (self 403, member target, audit, email, 409, member 403; admin target alert, re-enrollment); **PII scan** of logs, audit rows, emails and every response (secret, URI, codes, challenge and device tokens).
- Matrix: new principal **"admin without 2FA"** (403 `TWO_FACTOR_SETUP_REQUIRED` on every user/admin route except the allowlist) and the nine new routes, `routes.md` regenerated; `config.test.ts` (key required/weak/malformed/credential); `migrations.test.ts`; `tokens.test.ts` (`amr`); `render.test.tsx` (template); web `twoFactor.test.tsx` (code step, trust hidden for admins, recovery code, generic error and restart, admin gate wizard to the codes and `/admin`, slice flag, settings for admins and members, trusted-device removal).
- Test factories: admin fixtures are enrolled with a **test-only** secret by default (`createUser({ twoFactor })`), `createSession` marks sessions verified unless `twoFactorVerified: false`, and `loginAs`/`loginFull` answer the challenge.
- **E2E:** the harness seeds the ready admin, a second "reset" admin and a recovery-code member (`Inés`, with three test-only recovery codes) with a fixed **test-only** secret (`E2E_TOTP_SECRET`, public). `support/totp.ts` answers a code under a per-account lock shared by every Playwright worker (a directory in the run dir) and, test-only, clears the account's replay marker in the isolated `*_e2e` database first (like the server tests' `freshTotpCode`; the replay rule itself is covered by the server tests), so parallel admin logins never wait for the next 30-second step. `login()` answers the code step for accounts with a known secret. Journey 1 now enrolls the first-login admin through the gate (reading the key from the screen); journey 19 (a member enables 2FA, logs out, logs in with a code, trusts the device, the next login skips the code, removes the device, the code is back); journey 19b (recovery-code login + its email; the reset admin resets her 2FA from Panel → Usuarios; her session ends; password-only login). 19b uses its own admin because the ready admin is already close to the per-account login limit (10 per 15 minutes).

## Verification
On `wp/7-two-factor` (based on `origin/main` @ 2304d99, which had not moved at the end):
- `pnpm lint`: clean. `pnpm turbo run typecheck --force`: 6/6. `pnpm typecheck:e2e`: clean.
- `pnpm test`: **235 files, 3057 tests passed** (real Postgres).
- `pnpm build`: OK. Initial JS **183.03 kB** gzip (budget 190).
- `drizzle-kit generate`: "No schema changes, nothing to migrate".
- `pnpm audit` and `pnpm audit --prod`: no known vulnerabilities.
- Full `pnpm e2e` on isolated ports (API 4770, storage 4771, web 5770, Lighthouse 9377) and database `cuencada_w7_e2e`: **99 passed, 4 skipped** (pre-existing single-project journeys), Lighthouse ≥ 90 passed.
- `deploy:preflight`: every config key mapped (lists `vault_cuencada_totp_encryption_key`); its only failure in this worktree is the missing Acleron platform checkout (environmental).

## Backlog
- WebAuthn/passkeys (phishing-resistant; A16).
- A `TOTP_ENCRYPTION_KEY` rotation script (decrypt with the old key, re-encrypt with the new one, one transaction) and a key id column.
- "Approve sign-ins" notifications for new devices; a 2FA adoption counter on the admin dashboard.
