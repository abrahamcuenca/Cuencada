# WP-2.3b Stricter open invites + admin alert on acceptance
Owner: Senior JS Backend Engineer (with the matching FE change) · Reviewers: Security, TL · Branch: wp/2.3b-open-invites · PR: # (not opened)

Based on `origin/main` (28c55aa). Comes from the owner's decision on the WP-2.3 security audit.

## Why
Verifying an email proves that someone controls a mailbox, not that they belong to the family. If an open (not email-bound) invite link leaks, a stranger can join with it. So open links have to be short-lived and small, and admins must see every use.

## Scope
- **Contract** (`packages/types/src/auth.ts`): new constants `OPEN_INVITE_MAX_USES = 10`, `OPEN_INVITE_DEFAULT_USES = 5`, `OPEN_INVITE_MAX_HOURS = 72`, `OPEN_INVITE_MAX_LIFETIME_MS`, `OPEN_INVITE_MAX_DAYS = 3`, `OPEN_INVITE_DEFAULT_DAYS = 3`, `BOUND_INVITE_DEFAULT_DAYS = 7` and `BOUND_INVITE_MAX_DAYS = 30`.
  - `adminInviteCreateInputSchema`: `maxUses` and `expiresInDays` are now optional inputs. A transform fills in defaults by kind (open: 5 uses and 3 days; bound: 1 use and 7 days), and refines enforce the open-invite caps.
  - The output type is unchanged.
- **Server** (`apps/server/src/modules/invites/`):
  - `service.ts`: adds `effectiveInviteExpiresAt` and `effectiveInviteMaxUses` (the clamp for older rows). `isInviteUsable`, `effectiveInviteStatus` and `toAdminInviteListItem` now use them.
  - `adminRoutes.ts`:
    - `assertOpenInviteLimits`, a server-side guard that doesn't rely on the schema (400 `VALIDATION`).
    - `createdAt` is set from `app.clock`, so the 72 h cap and `expiresAt` use the same clock.
    - The list's status filter uses the effective (clamped) expiry in SQL.
  - `acceptAlerts.ts` (new): plans, records in the audit row and queues the admin alert.
  - `publicRoutes.ts`: accept uses the effective max uses, records `open` and `maxUses` in the audit row, plans the alert inside the transaction and queues it after commit.
- **Email** (`packages/emails`): new `admin-invite-accepted` template (`AdminInviteAcceptedEmail.tsx`), registered in `EmailKind` and `render.tsx` and exported.
- **Frontend** (`apps/web/src/features/admin/`):
  - `lib/inviteForm.ts`:
    - Picking "Enlace para compartir" resets the fields to 5 uses and 3 days; going back to "Por correo" sets 7 days (`changeInviteDelivery`). Choosing the admin role forces email and applies the same reset.
    - The caps come from the contract.
    - The error messages for open links state the range in days and hours.
  - `components/InviteForm.tsx`:
    - Help text: "Por seguridad, los enlaces abiertos caducan en 72 horas y avisan a los administradores cada vez que alguien se une."
    - The option hint and the expiry hint mention 72 horas.
  - `admin.module.css`: `.securityNote`.
  - `lib/metadata.ts` (after merging WP-0.8c's alert badges): `inviteAlertSkipped: true` also shows the "Aviso no enviado" badge in the bitácora.
- **Screenshots:** `docs/ux/screenshots/t8/invitaciones-enlace-375.webp` and `-1280.webp`.
  - Taken with headless Chromium against `vite preview`, with `/api/**` stubbed with fictional data.
  - Horizontal overflow is 0 px at both widths.
- **Docs:** ADR 0001 (owner decision, plus the updated invite rule) and a note in `WP-T8-FE.md`.
- **Not touched:**
  - `apps/server/src/__tests__/security/**`.
  - Routes and guards: no auth config changes, no new routes.
  - DB schema and migrations.

## Decisions
1. **Lifetime is still expressed in whole days.** The contract keeps `expiresInDays`, so the open maximum is 3 days (= 72 h) and the default is that maximum. Fractional days are rejected (`int()`), so the API can never create an open invite that lasts 72 h + 1 s. The 72 h + 1 s boundary is tested at accept time, against a test clock.
2. **Existing open invites are clamped at accept time, with no migration.**
   - Rows created under the old limits (20 uses, 14 days) stop being usable at the earlier of `expires_at` and `created_at + 72 h`, and after 10 uses.
   - They fail with the same generic `INVITE_INVALID` on inspect and accept (no enumeration).
   - On the 10th use of such a row, the status becomes `accepted`.
   - The admin list shows the clamped `expiresAt`, `maxUses` and status, and `?status=pending|expired` filters on the same SQL expression, so admins see what is actually enforced.
   - The DB check `invites_open_max_uses_check` (`max_uses <= 20`) stays as it is. Tightening it to 10 would be a contract (not expand-only) migration, and older rows could violate it. The app enforces 10 in three places: the schema, the route guard and accept. **Follow-up for the schema owner (optional):** tighten the check in a later contract migration after the existing open invites have expired.
3. **No email address in the alert.** The existing admin alerts (`admin-account-changed`, `admin-alert-limit`) contain names only, never addresses (`adminAlerts.ts`: "Names only, never addresses or secrets"). The new alert follows that precedent. It includes:
   - the member's display name;
   - the invite's admin-only note as its label (cleaned like a name, at most 80 characters);
   - the first 8 hex characters of the invite id;
   - uses so far / allowed;
   - the date.

   Admins can see the address in the admin users page.
4. **Link target.** The admin users page has no per-user URL filter, and the invites page has no per-invite one. Adding either would mean changing the contract or the frontend outside this scope, or putting a name in the URL. The CTA instead opens the bitácora filtered by the existing params: `/admin/bitacora?accion=invite.accepted&actor=<newUserId>`. That shows exactly this acceptance (the entity is the invite id) and carries ids only. From there the admin can find the account in Usuarios.
5. **Budget and cap.** Like T8-BE's admin alerts, these notices skip T1's per-recipient budget and are not counted by the global daily mail cap (`dailyMailCount`).
   - They have their **own** daily cap, `INVITE_ALERT_DAILY_CAP = 100`. It is counted from the `invite.accepted` audit rows' `inviteAlertRecipients`, under a transaction advisory lock (`invite-accepted-alerts`).
   - The counter is separate from `adminAlertRecipients` on purpose: anyone holding a link can trigger an acceptance. If acceptances shared the admin-account alert cap, they could use up the quota that protects non-exempt admin-change alerts, such as a promotion to admin.
   - Past the cap, the alert is skipped. The audit row gets `inviteAlertRecipients: 0, inviteAlertSkipped: true`, and `mail.invite_alert_cap_reached` is logged.
   - There is no separate "limit reached" email: the existing limit template's copy is about admin-account changes, and by then admins have already had 100 alerts that day.
   - Volume is also bounded by 10 uses per link, 72 h, and the per-IP and per-token accept rate limits.
6. **Email-bound invites don't alert.** An admin chose the mailbox, the invite is single-use, and accepting it requires typing the bound address. An alert would add noise without adding any signal.
7. **Fire-and-forget, after commit.** The alert is planned inside the accept transaction (recipients, cap, audit metadata) and queued with `sendInBackground` only after the transaction commits. So a rolled-back acceptance sends nothing, and a mail failure (logged by the queue) never fails the acceptance. Idempotency key: `admin-invite-accepted:<auditId>:<recipientId>`.
8. **Audit.** `invite.accepted` was already recorded. Its metadata now also carries `open`, `maxUses` (effective) and the alert counters. Ids and counts only; no addresses.

## Tests
- `packages/types/src/auth.test.ts`:
  - open defaults (5 uses, 3 days = 72 h);
  - uses 0/1/10/11;
  - days 0/1/3/4;
  - fractional days rejected (no 72 h + 1 s);
  - bound rules unchanged (1 use, 7/30 days).
- `apps/server/src/modules/invites/openInvites.test.ts` (real Postgres, `inject()`):
  - default open invite (5 uses, `expiresAt - createdAt = 72 h`);
  - over-limit creation is 400 (0 and 11 uses, 0 and 4 days, the old 20/14), and the boundaries are 201;
  - accepts at 72 h − 1 s, and at 72 h + 1 s gives the same `INVITE_INVALID` body as an unknown token;
  - older row past 72 h after creation: accept and inspect fail generically, and the admin list shows it `expired` with the clamped `expiresAt` and `maxUses: 10`;
  - older row with 20 allowed uses stops at 10 and becomes `accepted`;
  - one alert per active admin per acceptance (none to a disabled admin or a member). The alert has the right copy, uses and bitácora link, and no member address in the text, the HTML or the audit row. A second acceptance sends a second alert with "2 de 5";
  - no alert for bound invites, whether emailed or copy-link;
  - no alert, no user and no use when the acceptance rolls back (a DB trigger forces a failure on the `invite.accepted` audit insert);
  - acceptance still succeeds when the alert email fails;
  - the cap skips the alert and records it.
- `apps/server/src/modules/invites/invites.test.ts`: caps updated to the new limits (10/3; boundary 400s at 11/4).
- `packages/emails/src/render.test.tsx` (`admin-invite-accepted`):
  - copy, link and uses;
  - never says to ignore the email;
  - fallbacks with no label and an invisible-only name;
  - escaping and https-only links;
  - rejects a malformed short id or inconsistent counts.
- `apps/web/src/features/admin/lib/lib.test.ts`:
  - delivery defaults (5/3, back to 7, admin forces email);
  - open caps and messages;
  - the 0-day range message.
- `apps/web/src/features/admin/AdminInvites.test.tsx`:
  - the open link shows 5 / 3 with max 10 / 3 and the security note;
  - validation of 11 / 4;
  - the created body uses 5 / 3.

## Verification
`pnpm lint`, `pnpm turbo run typecheck --force`, `pnpm test` and `pnpm build` all pass, and the web bundle is within budget (174 kB of 190 kB gzip).

## Review log
- **Security: APPROVED at 4d5af70**, with follow-ups that are handled in this PR as separate commits:
  - **P1 (Medium, pre-existing): accepting an admin-role invite created a new admin without any alert.**
    - Every other active admin now gets the existing `admin-account-changed` notice with the "promoted" change ("Le dio el rol de administrador"). The inviter is shown as the actor ("Un administrador" if that account is gone).
    - Decided in the accept transaction (`planNewAdminAlert` in `admin/adminAlerts.ts`) and queued after commit with `queueAdminAlerts`.
    - The new admin is not told: they accepted it themselves.
    - It is **cap-exempt**, like demote, disable and force-reset, because it changes who holds admin access. It still adds to `adminAlertRecipients`. The audit row gets `adminAlertRecipients` and `adminAlertExempt`.
    - **Not alerted on creation:** the moment admin access exists is the acceptance, and creation is already in the bitácora. A creation alert would need new copy (no `AdminAccountChange` fits "invited as admin"), and every admin invite would then notify twice. If an earlier warning is wanted, it belongs in the backlog.
    - Tests: the other admins (inviter included) get one alert each; the new admin and members get none; no open-invite alert; a rollback sends nothing.
  - **L1: a link-like display name could phish admins through auto-linking.**
    - New shared helpers in `packages/emails/src/format.ts`:
      - `defangLinks`: `://` becomes `[:]//`, and a dot that starts a domain-like label becomes `[.]`. ASCII, ideographic and fullwidth dots are covered. Visible ASCII only, no zero-width characters. Initials like "J.R." are kept.
      - `cleanAlertName`: `cleanName` followed by `defangLinks`.
    - All three admin alert templates (`admin-account-changed`, `admin-alert-limit`, `admin-invite-accepted`) now use it for every user-controlled name and label.
    - Non-admin emails are unchanged: there the name shown is the sender's (an admin's) or the reader's own.
    - Tests (`render.test.tsx`): each admin template, in text, HTML and subject; plus `defangLinks` unit cases.
  - **L2: daily-limit notice for open-invite alerts**, mirroring the admin-account alerts.
    - The first capped acceptance of the UTC day sends ONE `admin-alert-limit` email to every active admin, using the new `topic: "open-invites"` copy ("Hoy muchas personas se unieron… con enlaces de invitación abiertos…"). It links to `/admin/bitacora?accion=invite.accepted`.
    - That audit row gets `inviteAlertLimitNotice: true` and `inviteAlertSkipped: true`. Later capped acceptances that day send nothing.
    - The counter stays separate from the admin-account alert quota (tested: a promotion still alerts when the invite cap is exhausted).
    - The admin-account copy now also says that a new admin is always announced (P1).
    - The bitácora shows a "Límite de avisos alcanzado" badge for `inviteAlertLimitNotice`.
    - Supersedes decision 5's "no separate limit email".
  - **L3 (also TL nit 1):** `POST /api/invites/inspect` now returns the effective (clamped) `expiresAt`, so an older open invite shows its real 72 h end. Tested.
- **Tech Lead: APPROVED at 4d5af70.** Non-blocking item folded in:
  - **Older open invites clamped by uses** (for example 12 of 20 used) are refused at accept, but the list showed them as pending ("Usos: 12 de 10").
  - `effectiveInviteStatus` now reports a stored `pending` invite whose uses reach the clamped maximum as `accepted` (used up), which wins over `expired`.
  - The SQL twins (`inviteExhaustedSql`, `effectiveInviteExpiresAtSql`, `invitePendingSql` in `invites/service.ts`) drive the list's `pending`, `expired` and `accepted` filters, and also the dashboard's `invitesPending` count (`admin/summaryRoutes.ts`), so all three agree.
  - `useCount` is still shown as stored (history), next to the clamped maximum and the "used" status.
  - Tested.
