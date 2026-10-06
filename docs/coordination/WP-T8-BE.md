# WP-T8-BE Admin console API [SEC]
Owner: Backend · Reviewers: TL, Security · Branch: wp/t8-be-admin · PR: # (not opened)

Based on `origin/main` (2bcb7a0, includes T1-BE, T2-BE, T3-BE, T4-BE, T6-BE, WP-2.1).

## Scope
- `apps/server/src/modules/admin/**`:
  - `users.ts`: user list (escaped search, keyset paging, aggregates), the admin-users advisory lock, target lock + actor re-check, active-admin count
  - `userRoutes.ts`: list, PATCH, revoke-sessions, force-password-reset, verify-email
  - `auditRoutes.ts`: read-only audit log viewer
  - `summaryRoutes.ts`: dashboard counters (one SQL statement)
  - tests: `userRoutes.test.ts`, `auditRoutes.test.ts`, `summaryRoutes.test.ts` (real Postgres, `inject()`)
- `packages/types/src/admin.ts`: contract amendments (below).
- Imported (not edited): `modules/auth` (`revokeSessions`, `burnPendingEmailTokens`, `issueBudgetedEmailToken`, `sendInBackground`, `EMAIL_TOKEN_TTL_MINUTES`), `modules/media/cursor.ts` (`encodeCursor`/`decodeCursor`, microsecond keyset cursor), `modules/family/repository.ts` (`escapeLike`).

## Interfaces exposed
Every route is `auth: "admin"` (role and status come from the DB on each request).

| Route | Response | Notes |
|---|---|---|
| `GET /api/admin/users?q&role&status&cursor&limit` | `Page<AdminUserListItem>` | Newest first (`created_at desc, id desc`), microsecond keyset cursor. `q` matches display name **or email** with escaped `ILIKE` (admins may see emails). `activeSessionCount` = sessions not revoked and not idle/absolute-expired. `personId` from `people.user_id` |
| `PATCH /api/admin/users/:id` | `AdminUserListItem` | `{ role?, status?, mustChangePassword?: true }`. 403 self role/status change · 409 last active admin · 404 · 400 |
| `POST /api/admin/users/:id/revoke-sessions` | 204 | `admin_revoked`. 403 on the caller's own account (use T1's session list) |
| `POST /api/admin/users/:id/force-password-reset` | `AdminForcePasswordResetResult` **(new)** | Sets `must_change_password`, revokes all sessions (`admin_revoked`), burns pending email links, issues a reset link through T1's `issueBudgetedEmailToken` (active accounts only) and queues the `password-reset` email. `emailQueued: false` for disabled accounts or when a budget/cap skipped it. 403 on self |
| `POST /api/admin/users/:id/verify-email` | `AdminUserListItem` **(new)** | Sets `email_verified_at` if null. Idempotent: an already-verified address keeps its time and writes no audit row |
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

**Chat sockets:** T7's `closeSocketsForUser` is not on main. `userRoutes.ts#closeChatSockets` is called after disable, revoke-sessions and force-reset and is a documented `TODO(T7)` no-op.

### Audit rows (ids, field names and counts only)
| Action | Metadata |
|---|---|
| `user.disabled` | `{ fields, revokedSessions, burnedEmailLinks, role? }` |
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
- **Self-service routes refuse self:** force-reset and revoke-sessions answer 403 on the caller's own account (they would log the admin out; T1 has change-password and the session list for that). Verify-email on self is allowed.
- **Force reset uses the user tier** of the mail budget because it goes through T1's `issueBudgetedEmailToken` (as requested). If the recipient just requested a reset themselves, the per-recipient budget may skip the email: the admin sees `emailQueued: false` and the account is still forced to change.
- `mustChangePassword: true` via PATCH only sets the flag (the guard enforces it on the next request); no revocation.

## Requests (→ orchestrator)
- **T7:** export `closeSocketsForUser(app, userId)` from `modules/chat`; T8 will replace the `closeChatSockets` TODO (called on disable, revoke-sessions, force reset).
- **T8-FE:** consume `GET /admin/summary`, the two new user actions and `emailQueued`; T6-FE can switch `searchUsersForPersonLink` to `GET /admin/users`.
- **WP-0.2 doc owner:** add the three new routes to the contract table.
- **WP-2.3:** add the T8 routes to the authorization matrix.

## Verification
See the final report of this WP (lint, `turbo run typecheck --force`, `pnpm test`, `pnpm build`).
