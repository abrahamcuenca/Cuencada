# WP-4.2 Invites linked to tree people [SEC]
Owner: Senior full-stack · Reviewers: TL, Security · Branch: wp/4.2-invite-person

Based on `origin/main` d1b0018 (WP-4.0 merged). Built on the WP-4.0 interfaces (`adminInviteCreateInputSchema.personId`, `InviteIssueCode`, `FamilyIssueCode.PersonLinkedToOther`). No migration. Runs in parallel with 4.1 (family editing), 4.3 (photos) and 4.4 (contacts); this WP stays in the invite files, plus one line on the tree page.

## Scope
- **Contracts** (`packages/types/src/auth.ts`):
  - `InviteIssueCode.PersonHasPendingInvite = "PERSON_HAS_PENDING_INVITE"` (409 `CONFLICT`). The WP-4 issue-code test in `family.test.ts` lists it.
  - `AdminInvitePerson` (`{ id, fullName }`) and `AdminInviteListItem.person?: AdminInvitePerson | null` (optional on the wire, so older servers still parse).
  - `AdminInviteCandidate` (+ schema): `id`, `fullName`, `nickname`, `familyBranch`, `birthYear`, `deathYear`, `deceased`, `linked`, `pendingInvite`. Never the account id. `isInvitableCandidate()`.
  - `adminInviteCandidatesQuerySchema` (`q` required, trimmed, 1–100; `limit` 1–20, default 8), `AdminInviteCandidates` (`{ items }`, not paginated), `ADMIN_INVITE_CANDIDATES_MAX`.
- **Server** (`modules/invites`):
  - `invitePerson.ts` (new): `assertPersonInviteIsBound`, `assertInvitablePerson` (row lock), `lockPerson`, `linkAcceptedPerson`, `searchInviteCandidates`, `findInviteCandidate`.
  - `POST /api/admin/invites` with `personId`:

    | Case | Answer | Detail code |
    |---|---|---|
    | open link (`email: null`) | 400 `VALIDATION` | `INVITE_PERSON_REQUIRES_BOUND` |
    | unknown person | 400 `VALIDATION` | none (as before) |
    | deceased | 400 `VALIDATION` | `INVITE_PERSON_DECEASED` |
    | already has an account | 409 `CONFLICT` | `PERSON_LINKED_TO_OTHER` |
    | already has a pending invite | 409 `CONFLICT` | `PERSON_HAS_PENDING_INVITE` |

    All details have `path: "personId"`. The open-link check runs before any lookup, so it answers the same for any id. The other checks run inside the create transaction with the person row locked (`FOR UPDATE`), so two concurrent creates for one person cannot both pass. "Pending" is the same predicate as the list filter (`invitePendingSql`: stored pending, uses left, not expired), so an expired or revoked invite does not block a new one.
  - `POST /api/invites/accept`: the person the invite names is read first, then locked **before** the invite row. A person delete locks the person and then (FK `ON DELETE SET NULL`) the invite, so the reverse order could deadlock. Under the lock the person must still exist, be unlinked and living. Otherwise the account gets a new person. The `invite.accepted` audit row now always has `personId` (the person the account got) and `personLink` (`linked` | `created` | `fallback`); a fallback adds `requestedPersonId` and `personFallbackReason` (`linked` | `deceased` | `deleted`). Ids and enums only. The link is a conditional `UPDATE … WHERE user_id IS NULL AND NOT deceased`, and `people.user_id` is unique, so a person never holds two accounts.
  - `GET /api/admin/invites` and every list item answer (create, revoke, resend) carry `person` (left join on `people`).
  - `GET /api/admin/invites/people?q=` (admin, 120/min per IP): living people without an account matching name, nickname or branch (`ILIKE`, wildcards escaped), ordered by name; a pending invite is flagged, not hidden. `GET /api/admin/invites/people/:id` (admin): any person's status (404 when unknown), for the person-page button and the pre-filled form.
- **Web** (`features/admin`):
  - `InvitePersonPicker`: "Persona en el árbol (opcional)", email invites only. Debounced search (2+ chars) over the new endpoint; each result shows nickname, birth year and branch (`describeCandidate`: "n. 1990 · Rama Norte"); a person with a pending invite is listed but disabled ("Invitación pendiente"). The chosen person shows as a card with "Quitar persona" and "Le sugeriremos este nombre".
  - `InviteForm`: the picker sits under "Correo"; on "Enlace para compartir" it is replaced by the note "Para vincular a una persona del árbol, usa una invitación por correo.", and switching to the link drops the chosen person (`changeInviteDelivery`). `validateInviteForm` sends `personId` only for email invites. A server refusal with `path: "personId"` is shown on the picker. New `initialPerson` prop.
  - `InvitesPage`: "Para: {nombre}" on each card; `?persona=<id>` opens the form pre-filled (or explains "No se puede vincular a X: ya tiene cuenta." and leaves the picker empty); cancel or create drops the parameter.
  - `InvitePersonButton` (`features/admin/components/InvitePersonButton.tsx`): a link "Invitar" (`aria-label` "Invitar a {nombre}") to `/admin/invitaciones?persona=<id>`, rendered only for admins and only when the person is living, unlinked and has nothing pending (it asks `GET /admin/invites/people/:id`; members never call it). Wired into the tree page's admin actions with one line in `FamilyTreePage.tsx` (WP-4.1's file; expect a trivial merge).
  - RTK: `searchInviteCandidates`, `getInviteCandidate` (tag `Invite/CANDIDATES`, invalidated by create and revoke).

## Decisions
- **Dedicated admin picker endpoint instead of `PersonSearch`/`PersonDetails`.** The member search (`GET /family/people`) returns `PersonSummary` without years or branch, includes linked and deceased people, and `PersonSearch` is wired to it; extending it would touch WP-4.1's files and the member contract. The admin endpoint filters server-side and computes `pendingInvite`. `InvitePersonPicker` copies `PersonSearch`'s interaction (debounce, live status, result buttons) and reuses `useDebouncedValue`.
- **"Pre-fills the display name"**: the create input has no display-name field. The server already stores the person's `fullName` as the invite's `displayName`, which the invitee sees as the suggested name (`inspect.suggestedDisplayName`) and the email greeting uses. The form says so on the chosen-person card.
- **Pending-invite code**: `PERSON_HAS_PENDING_INVITE` (409), in `InviteIssueCode` (open detail-code channel, ADR 0001 §4).
- **Deleted before accept**: the 0004-era FK sets `invites.person_id` null on delete, so such an invite behaves as a plain bound invite (`personLink: "created"`, list `person: null`). Only a delete racing the accept is visible as a `deleted` fallback. The `invite.created` audit row keeps the original `personId`. Revoking pending invites on person delete belongs to the delete route (backlog, WP-4.1).
- **Admin re-link race**: `PATCH /api/admin/people/:id { userId }` takes the person row lock too, so it serializes with the accept. If the admin's change commits first, the accept falls back; if the accept commits first, the admin's explicit re-link wins and the invitee's account loses the person (existing admin behaviour; backlog item for WP-4.1). In every order a person holds at most one account and an account at most one person (tested).
- The candidate `pendingInvite` flag is a second query over the page's ids: a correlated subquery in a single-table Drizzle selection renders unqualified column names.
- E2E fixture: the invited tree person is "Anabel {Apellido}" per project (fictional), a child of the seeded parent. "Ana {Apellido}" is already the cast member Ana, and journey 7 finds Ana's button by a name prefix.

## Security
- Admin-only routes (matrix rows for both new routes; IDOR probe: a member asking for another member's linked person gets 403). Rule probe on `POST /api/invites/accept`: an invite naming a person linked to another member creates the account but leaves that person's `user_id` unchanged.
- The picker and list never return account ids (schema strips unknown keys; tests assert the id is absent). The PII scanner covers `GET /api/admin/invites/people`.
- The audit metadata holds ids and enums only (tested: no names).
- Threat model: new **E/T (WP-4.2)** row. ADR 0001 §6: invite paragraph and the new code.

## Tests
- `apps/server/src/modules/invites/invitePerson.test.ts` (22): create success + `person` in the list; `person: null` without one; open link → 400 `INVITE_PERSON_REQUIRES_BOUND` with identical bodies for known and unknown ids and no row written; deceased → 400; linked → 409 `PERSON_LINKED_TO_OTHER` (no account id in the body); pending → 409 `PERSON_HAS_PENDING_INVITE`, allowed again after a revoke; an expired invite is not pending; three concurrent creates → one 201, two 409; unknown person on a bound invite → 400 without a code. Picker: only living unlinked people, years/branch, pending flag, no account id; nickname/branch matching, `%` escaped, `q` required; by id incl. 404; 401/403. Accept: links without a second person and audits ids only; fallback when linked before, died before, deleted before (`created`); **races under the person lock** (the test holds the lock, waits until the accept blocks on it, then commits): admin link wins → fallback `linked`; delete → no deadlock, fallback `deleted`; death → fallback `deceased`; accept vs. the real `PATCH /api/admin/people/:id` → never two accounts on a person; two accepts of one token → one 201, one person.
- Contracts: `auth.test.ts` (list item with/without `person`, candidate strips `userId`, query rules, `isInvitableCandidate`), `family.test.ts` (issue-code list).
- Web: `AdminInvitePerson.test.tsx` (9 cases): picker results with years/branch, disabled pending person, `personId` sent, "Para:" card; open link hides the picker with the note and drops the person; server refusal on the picker; `?persona=` pre-fill and cancel clears it; a blocked `?persona=` person explained; tree page "Invitar" for admins → pre-filled URL; hidden for linked and pending people; members never call the admin API. `lib.test.ts`: `personId` only on email invites, `describeCandidate`, `candidateBlockedReason`.
- E2E journey 12 (`tests/e2e/invitePerson.spec.ts`, all three projects): the admin opens the person in the tree, "Invitar" pre-fills the form, sends by email; the list says "Para: …"; the invitee accepts from the mail sink on a phone; their tree opens on that person with the seeded parent; the admin's person search finds exactly one such person and none under the typed name; the "Invitar" link is gone.
- Screenshots: `docs/ux/screenshots/t8/invite-person-form-{375,1280}.webp`, `invite-person-list-{375,1280}.webp`, `docs/ux/screenshots/e2e/12-invited-person-tree-375.webp`.

## Verification
- See the final report for the run after merging `origin/main`.
