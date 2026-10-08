# WP-4.6 Refresh race on reload (grace re-issue) [SEC]
Owner: Senior JS engineer (auth/security) · Branch: `wp/4.6-refresh-race`

Based on `origin/main` f45e6bb (WP-4.5 merged, PR #49). Fixes the intermittent e2e journey 11b ("Ana's session lost on reload") and the real-user bug behind it. Also covers Tech Lead note 2 from PR #49 (invite accept racing a merge).

## Diagnosis: the Tech Lead's hypothesis is confirmed
- **Server test** (scratch, before the fix): rotate, then present the old token at t+1 s → 409 `REFRESH_RACE`, at t+1.15 s → 409, at t+12.15 s → 401, session revoked `refresh_reuse`, one `auth.refresh_reuse_detected` row. These were exactly the client's three attempts (first try, a 150 ms retry, then the 11 s wait).
- **Failing 11b run** (1 of 30 runs of 11b failed on the pre-fix build, on `pixel-7`). Its session's `refresh_tokens` chain showed three rotations 340 ms and 215 ms apart, one per `page.goto` (`/`, `/mas`, `/`). The last rotation's cookie never reached the jar, because the test went to `/admin` before the boot refresh answered. The audit log had `auth.refresh_race` at +0.12 s and +0.29 s after that rotation, then `auth.refresh_reuse_detected` 11 s later. By then the test had already timed out waiting for "Acceso restringido".
- **Deterministic e2e** (new journey 9b against the pre-fix build): it fails at the same point, with two `auth.refresh_race` rows and no "Salir" after the reload.
- **Cause:** a reload aborts the in-flight refresh after the server committed the rotation, so the browser keeps the old cookie. The next load presents it inside the 10 s grace window and gets 409. The client then waited 11 s, which was by design (WP-0.8c, from the T1 L1 note) to turn a thief race into reuse detection. That design also turns a lost response into reuse, so the session is revoked. On the e2e build, 3 of 30 later 11b runs hit the grace path, so roughly 10 % of those runs would have lost the session.

## Fix
### Server (`modules/auth/sessions.ts`, `sessionRoutes.ts`)
- **Grace re-issue.** Suppose a used token `P` is presented within `REFRESH_REUSE_GRACE_MS` (10 s), and its immediate successor `S` (`P.replaced_by_token_id`, same session) is unused and unexpired. Then `S` is rotated in turn: it is marked used and linked to a new token, and the session's idle expiry slides. The route answers 200 with a fresh cookie and access token for the same session (option (a) of the brief; the successor's raw token isn't stored, so option (b) was not possible).
- **Reuse rules:**
  - A second grace use of `P` finds `S` used, so it is reuse.
  - An older token whose successor was rotated normally isn't the immediate predecessor of the live token, so it is reuse.
  - A used token whose successor is missing from its session is reuse (fail closed).
  - A used token presented after the window is reuse, as before.
  - Reuse revokes the whole session and answers 401 with the cookie cleared. `auth.refresh_reuse_detected` now carries `metadata.reason` = `after_grace` | `successor_used` | `successor_missing`.
  - An expired successor inside the window is a plain 401 with nothing revoked; it is practically unreachable, because the session's idle expiry would have passed too.
- **Locking:** the refresh now locks the **session** row first (`SELECT … FOR UPDATE OF sessions`), then the token rows. Every token write of a session happens under that lock. Two concurrent refreshes therefore serialize, always in the same order, and there is no predecessor/successor deadlock. Logout (`findCookieSession`) already locks only the session.
- **Audit:** a new `AuditAction.RefreshGraceReissued` = `auth.refresh_grace_reissued` (actor = the user; entity = the session). Its metadata is `{ presentedId, successorId }`, which are `refresh_tokens` row ids. The keys avoid "token" because `recordAudit` redacts any key matching `/token/`. The admin audit viewer label is "Sesión renovada de nuevo tras una recarga". `auth.refresh_race` is no longer written; the action stays for old rows.
- **The route never answers 409 `REFRESH_RACE` now.** The code stays in `ErrorCode` for older clients. The route's config, auth mode (`cookie`: CSRF header + exact Origin) and response schemas are unchanged, so no security-matrix row changes and `routes.md` is unchanged. A test checks that a foreign Origin gets 403 before any grace re-issue, with nothing changed.
- **Threat note:** see ADR 0001 §3 ("Accepted risk (revised)"). A thief who replays a stolen token within 10 s after the victim's rotation gets one working chain until the next presentation of a used token. That presentation is detected as reuse and revokes everything. A User-Agent binding was considered and left out.

### Client (`apps/web/src/shared/api/reauth.ts`)
- `REFRESH_RACE_GRACE_WAIT_MS` (11 s) is gone. `REFRESH_RACE_RETRY_DELAYS_MS = [1_000, 1_000]`: on a 409 `REFRESH_RACE`, the client retries after about 1 s, at most twice, then logs out locally. Every retry lands inside the grace window.
- This bounded retry is kept **only** for a server that still sends `REFRESH_RACE` (a pre-4.6 build during a deploy or rollback). Against the current server, a lost response heals on the first attempt. A logout still ends a pending pause at once (`cancelOnlineRefreshRetry` → `cancelRaceWait`), and the epoch check still discards a late result.

### Invite accept vs. merge (`modules/invites/publicRoutes.ts`), TL note 2 on PR #49
- The accept read the invite's `person_id` before the transaction, so that it can lock the person before the invite. A merge that committed in between had already re-pointed the invite to the kept person and deleted the duplicate. The accept then fell back to a new person (`deleted`) instead of linking the kept one.
- Now the transaction re-reads `person_id` under the invite lock. If the invite names another person, the attempt stops before any write (`repointed`). The route then retries **once** with that person, which keeps the person → invite lock order and all the usual re-checks: unlinked, living and email-bound. The second attempt doesn't retry again: if the invite moved again, it falls back as before.

## Tests
- **Server** `sessionRoutes.test.ts` (refresh block, 15 tests):
  - Grace re-issue works once. It answers 200 with a new cookie, the successor is used and links to the fresh token, the idle expiry slides, and there is one audit row with ids only and no token or hash. The new access token and the new refresh token both work.
  - A second grace use is reuse (`successor_used`): the session is revoked, and the re-issued token now gets 401.
  - An older token after two normal rotations gets no grace.
  - Grace is bound to the session. The phone's grace leaves the laptop's tokens untouched. A tampered cross-session successor link revokes only the presenting session (`successor_missing`), and the other session's token still works.
  - CSRF and Origin are checked before the grace path.
  - Reuse after the window (`after_grace`).
  - Two concurrent refreshes (`Promise.all`) both answer 200, leaving 3 tokens and one live one. Three concurrent refreshes answer [200, 200, 401], and the session is revoked.
- **Server** `invitePerson.test.ts`, under the held person lock:
  - A merge re-points the invite and deletes the duplicate; the accept links the **kept** person (audit `personLink: "linked"`, `personId` = keep, `useCount` 1, one account). This test fails on the old code.
  - Re-point plus keep linked meanwhile: one retry, then fallback `linked` with `requestedPersonId` = keep.
- **Web** `reauth.test.ts`:
  - The retry comes about 1 s after a 409 (no call at 0.9 s, a call by about 1.2 s).
  - At most two retries, and their delays sum to less than 10 s.
  - Three 409s log out after about 2 s, with no late attempt even 15 s later.
  - A logout during the pause ends it in under 500 ms.
- **E2E** journey **9b** (`tests/e2e/auth.spec.ts`, all three projects). Dario logs in. A Playwright route on `/api/auth/refresh` lets the boot refresh reach the API (`route.fetch()`, so the server rotates and commits), puts the old cookie back in the jar and aborts the response, the same as a reload cutting it short. The reload then shows "Salir" within 5 s with a new cookie, and further reloads and `/directorio` keep working. It fails on the pre-fix build.
- Journey 11b is unchanged: it now exercises the real reload-mid-refresh path and passes.

## Verification
- Before the fix: 11b `--repeat-each=10` on iPhone 13, Pixel 7 and desktop gave 29/30, with one failure carrying the audit rows above. 9b failed on the pre-fix build.
- After the fix:
  - 11b + 9b `--repeat-each=10` × 3 projects: 60/60. The DB had 31 `auth.refresh_grace_reissued` rows (30 from 9b, one from an 11b reload) and 0 `refresh_reuse_detected`.
  - 11b alone `--repeat-each=10` × 3 projects: 30/30, with 3 grace re-issues (three runs that would have flaked before) and 0 reuse.
- `pnpm lint` clean; `pnpm turbo run typecheck --force` 6/6; `pnpm test` 185 files, 2435 tests; `pnpm build` 4/4.
- `pnpm e2e` on isolated ports 3660/3661/4660 and database `cuencada_w46_e2e`: journeys and mobile gates 70/70, Lighthouse 1/1.
