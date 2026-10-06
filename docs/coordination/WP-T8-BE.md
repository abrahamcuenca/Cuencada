# WP-T8-BE Admin console API [SEC]
Owner: Backend · Reviewers: TL, Security · Branch: wp/t8-be-admin · PR: # (not opened)

Based on `origin/main` (2bcb7a0, includes T1-BE, T2-BE, T3-BE, T4-BE, T6-BE, WP-2.1).

## Scope
- `apps/server/src/modules/admin/**`:
  - `users.ts`: user list (escaped search, keyset paging, aggregates), the admin-users advisory lock, target lock + actor re-check, active-admin count
  - `userRoutes.ts`: list, PATCH, revoke-sessions, force-password-reset, verify-email
  - `auditRoutes.ts`: read-only audit log viewer
  - `summaryRoutes.ts`: dashboard counters (one SQL statement)
  - `adminAlerts.ts`: admin-account change alerts (Security L1)
  - tests: `userRoutes.test.ts`, `auditRoutes.test.ts`, `summaryRoutes.test.ts` (real Postgres, `inject()`)
- `packages/types/src/admin.ts`: contract amendments (below).
- `packages/emails` (authorized): new `admin-alert-limit` template and a `recipientIsTarget` variant of `admin-account-changed` (follow-up); the `admin-account-changed` template (`templates/AdminAccountChangedEmail.tsx`, `EmailKind.AdminAccountChanged`, exports, tests in `render.test.tsx`).
- Imported (not edited): `modules/auth` (`revokeSessions`, `burnPendingEmailTokens`, `issueBudgetedEmailToken`, `sendInBackground`, `EMAIL_TOKEN_TTL_MINUTES`), `modules/media/cursor.ts` (`encodeCursor`/`decodeCursor`, microsecond keyset cursor), `modules/family/repository.ts` (`escapeLike`).

## Interfaces exposed
Every route is `auth: "admin"` (role and status come from the DB on each request).

| Route | Response | Notes |
|---|---|---|
| `GET /api/admin/users?q&role&status&cursor&limit` | `Page<AdminUserListItem>` | Newest first (`created_at desc, id desc`), microsecond keyset cursor. `q` matches display name **or email** with escaped `ILIKE` (admins may see emails). `activeSessionCount` = sessions not revoked and not idle/absolute-expired. `personId` from `people.user_id` |
| `PATCH /api/admin/users/:id` | `AdminUserListItem` | `{ role?, status?, mustChangePassword?: true }`. 403 self role/status change · 409 last active admin · 404 · 400 |
| `POST /api/admin/users/:id/revoke-sessions` | 204 | `admin_revoked`. 403 on the caller's own account (use T1's session list) |
| `POST /api/admin/users/:id/force-password-reset` | `AdminForcePasswordResetResult` **(new)** | Sets `must_change_password`, revokes all sessions (`admin_revoked`), burns pending email links, issues a reset link through T1's `issueBudgetedEmailToken` (active accounts only) and queues the `password-reset` email. `emailQueued: false` for disabled accounts or when a budget/cap skipped it. 403 on self |
| `POST /api/admin/users/:id/verify-email` | `AdminUserListItem` **(new)** | Sets `email_verified_at` if null. Idempotent: an already-verified address keeps its time and writes no audit row. **403 on the caller's own account** (it would bypass the email proof; PR #24 review) |
| `GET /api/admin/audit-logs?actorUserId&action&entityType&entityId&from&to&cursor&limit` | `Page<AuditLogEntry>` | `created_at desc, id desc`, microsecond keyset cursor, `actorName` = actor's current display name (null for system rows or deleted actors), metadata as stored. **No write/delete endpoint** (tested: 404) |
| `GET /api/admin/summary` | `AdminSummary` **(new)** | See below |

### Mutation pipeline (every user mutation)
One transaction:
1. `pg_advisory_xact_lock(hashtext('cuencada:admin-users'))`: serializes every admin user mutation; later statements see whatever the previous holder committed.
2. **Actor re-check:** the caller must still be an active admin (a concurrent request may have demoted/disabled them after the auth guard ran) → 403 "Tu cuenta ya no tiene permisos de administración."
3. Target row `SELECT … FOR UPDATE` → 404.
4. Guardrails (PATCH): own role/status change → 403 "No puedes cambiar tu propio rol ni desactivar tu propia cuenta."; a change that removes an active admin when no other active admin exists → 409 "Debe quedar al menos un administrador activo."
5. Write, side effects, one `recordAudit` row.

**Disable:** `status = disabled`, every live session revoked with `revoked_reason = user_disabled`, `burnPendingEmailTokens()` (T1 Security L3 request). The auth guard already rejects disabled users, so the old access token gets 401 on the next request (tested). **Re-enable:** `status = active`; revoked sessions and burned links stay dead, so the user logs in again (tested). Role changes need no revocation (the guard reads the role from the DB).

**Chat sockets (Security L2, PR #24): T7 MUST wire this.** T7's `closeSocketsForUser` is not on main. `userRoutes.ts#closeChatSockets` is called after disable, revoke-sessions and force-reset and is a documented `TODO(T7)` no-op: until it is wired, a socket opened before a disable keeps receiving messages until it reconnects (REST and the ticket guard already refuse). The T7 PR must replace the body of `closeChatSockets` with `closeSocketsForUser(app, userId)`; Security will check it there.

### Admin-account change alerts (Security L1, PR #24; follow-up L3, `wp/t8-be-alerts`)
When an **administrator** account changes (the target was or becomes an admin), every **other** active admin gets the `admin-account-changed` email ("Cambio en una cuenta de administrador"): who changed whom, what changed and when, with a button to `/admin/bitacora`. Names only, no addresses, no secrets.
- **Triggers:** promoted, demoted, disabled, re-enabled, `mustChangePassword` set (PATCH), and a forced password reset of an admin. Member-only changes send nothing.
- **Recipients:** active admins except the actor, read inside the mutation transaction after the change. **The target is notified too** (a "tu cuenta" variant, without the bitácora button it may no longer open) when it is demoted, disabled or force-reset, even though it loses admin, and whenever it is still an active admin after the change (e.g. promoted).
- Sent after commit on T1's mail queue (`sendInBackground`); idempotency keys `admin-account-changed:<auditId>:<recipientId>` and `admin-alert-limit:<auditId>:<recipientId>`.
- **Limits:**
  - These security notices skip the per-recipient budget **and do not depend on the global daily mail cap** (the reserved-tier check was removed): a demotion still alerts after invites exhausted the global cap (tested). Item 4 of the follow-up (checking the global cap per recipient, N−1 overshoot) is therefore moot.
  - They are bounded by their own cap, `ADMIN_ALERT_DAILY_CAP = 100` emails per UTC day (counted from the audit rows' `adminAlertRecipients`, under the admin-users lock), by the number of admins, and by the 60/min per-admin mutation limit.
  - **Exempt from the alert cap:** demote, disable and force-reset of an admin always send (`adminAlertExempt: true`); they still add to the day's count.
  - **Limit notice:** the first non-exempt alert of the day that no longer fits is replaced by ONE `admin-alert-limit` email ("Se alcanzó el límite de avisos de seguridad de hoy") to every other active admin, saying removals are still announced (`adminAlertLimitNotice: true`). Later non-exempt alerts that day send nothing (`adminAlertSkipped: true`), and `mail.admin_alert_cap_reached` is logged.
- Audit metadata: `adminAlertRecipients` (count), plus `adminAlertExempt` / `adminAlertLimitNotice` / `adminAlertSkipped` flags.
- **Not counted by T1's `dailyMailCount`**, by design: the alerts must not be blocked by, nor block, the global cap.
- Tested (`adminAlerts.test.ts`): other admin and target receive the right copy; actor, a disabled admin and members don't; forced reset alerts the target alongside the reset email; member-only changes send nothing; demotion after the global cap is exhausted; exempt actions past the alert cap; the limit notice fires once, then non-exempt alerts are skipped while exempt ones still go out.

### Audit rows (ids, field names and counts only)
| Action | Metadata |
|---|---|
| `user.disabled` | `{ fields, revokedSessions, burnedEmailLinks, role?, adminAlertRecipients? }` |
| `user.enabled` **(new)** | `{ fields, role? }` |
| `user.updated` | `{ fields, role?: { from, to } }` (`fields` ⊆ `role`, `status`, `mustChangePassword`) |
| `user.sessions_revoked` | `{ revokedSessions }` |
| `user.password_reset_forced` **(new)** | `{ revokedSessions, burnedEmailLinks, emailQueued }` |
| `user.email_verified_by_admin` **(new)** | `{ fields: ["emailVerified"] }` |

`entityType: "user"`, `entityId` = target id, `actorUserId` = admin, `ip`. No email or display name is ever written (tested). A no-op PATCH writes nothing. Note: `recordAudit` redacts any metadata key containing `token`, so the count is named `burnedEmailLinks`.

### Summary (`AdminSummary`)
One statement, all counts in SQL:
- `usersActive`, `usersDisabled`, `usersUnverified` (active, `email_verified_at is null`), `activeAdmins`
- `invitesPending`: `status = pending and expires_at > now`
- `mediaPendingReview`: live (`deleted_at is null`, upload started) and `pending_review`
- `mediaReported`: live items with a report **newer than `moderated_at`**, i.e. still needing a look (the media queue's `reported=true` filter lists every reported item; this counter drops once an admin moderates)
- `upcomingEdition`: the earliest **published** edition with `ends_at > now` (so an active edition counts too) with RSVP `yes`/`maybe`/`no` counts and `rsvpGuests` (sum of `guest_count` on `yes`), or `null`. This uses instants, not T2's timezone-aware day status; close enough for a counter.

### Rate limits
Mutations: 60/min per IP (route `rateLimit`) **and** 60/min per admin (one `extraRateLimitHook` counter shared by all four mutation routes, keyed on the user id, in `preHandler`). Reads fall under the global 300/min. Tested (61st → 429).

## Contract amendments (`packages/types/src/admin.ts`) — flagged
1. `AuditAction.UserEnabled = "user.enabled"`, `UserPasswordResetForced = "user.password_reset_forced"`, `UserEmailVerifiedByAdmin = "user.email_verified_by_admin"` (the existing "every action passes `auditActionSchema`" test covers them).
2. `AdminForcePasswordResetResult` + `adminForcePasswordResetResultSchema` (`{ user, emailQueued }`).
3. `AdminSummary`, `AdminSummaryEdition` + schemas.
4. New routes not yet in the WP-0.2 table: `POST /api/admin/users/:id/force-password-reset`, `POST /api/admin/users/:id/verify-email`, `GET /api/admin/summary`.

## Decisions
- **Self-change is 403, last admin is 409**, following the existing `adminUserPatchInputSchema` JSDoc in the contract ("403 to change the caller's own role or status", "409 to demote/disable the last active admin"). The brief grouped both under 409; the contract wins unless the orchestrator says otherwise. Because the caller is always an active admin, the 409 is only reachable when the actor re-check is bypassed; it is defence in depth. The concurrency test (two admins demote/disable each other simultaneously, 5 rounds) always leaves exactly one active admin: the loser gets 403 from the actor re-check.
- **Advisory lock instead of `FOR UPDATE` on all admin rows:** no deadlock ordering concerns and it also covers the actor re-check. Cost: admin user mutations are serialized (fine at family scale).
- **Self-service routes refuse self:** force-reset, revoke-sessions and (since the PR #24 review) verify-email answer 403 on the caller's own account.
- **Force reset uses the user tier** of the mail budget because it goes through T1's `issueBudgetedEmailToken` (as requested). If the recipient just requested a reset themselves, the per-recipient budget may skip the email: the admin sees `emailQueued: false` and the account is still forced to change.
- `mustChangePassword: true` via PATCH only sets the flag (the guard enforces it on the next request); no revocation.

## Requests (→ orchestrator)
- **T7 (Security L2, blocking for the T7 PR):** export `closeSocketsForUser(app, userId)` from `modules/chat` and wire it into `admin/userRoutes.ts#closeChatSockets` (called on disable, revoke-sessions, force reset).
- **Config:** move `ADMIN_ALERT_DAILY_CAP` to config when `config.ts` is unfrozen. (Admin alerts are intentionally outside T1's `dailyMailCount`.)
- **T8-FE:** render audit metadata values as text only (never HTML).
- **T8-FE:** consume `GET /admin/summary`, the two new user actions and `emailQueued`; T6-FE can switch `searchUsersForPersonLink` to `GET /admin/users`.
- **WP-0.2 doc owner:** add the three new routes to the contract table.
- **WP-2.3:** add the T8 routes to the authorization matrix.

## Test isolation (PR #24 flake)
The review's first full run hit 30 s hook timeouts in `auditRoutes`/`summaryRoutes` and then a summary assertion that saw an extra user and edition. A timed-out hook keeps running in the background, so its inserts can land after the next test's `resetDb`; the second failure was a consequence of the first. Fixes:
- Both files build **one app per file** (`beforeAll`) instead of one per test, which was the heaviest part of each hook; per-test seeding is a handful of rows.
- **Audit tests** seed into a per-test time window and query only inside it, so foreign rows cannot change results.
- **Summary tests** assert **deltas** against a summary taken at the start of the same test; the edition under test starts one hour after the fixed clock (always the earliest upcoming); the null-edition case runs inside a rolled-back transaction.

## Verification
See the final report of this WP (lint, `turbo run typecheck --force`, `pnpm test`, `pnpm build`, `vitest --project server` ×3).
