# WP-4.1 Family editing by admins and members [SEC]
Owner: Senior full-stack engineer (BE + FE) with the UI/UX designer · Branch: `wp/4.1-family-editing`

Built on WP-4.0 (contracts, migration 0004, ADR 0001 §6) and merged with `origin/main` after WP-4.2 (PR #44). Owns the `PersonDetails` builder. It calls the WP-4.3 (`resolvePersonPhoto`) and WP-4.4 (`personContactCard`, `loadPersonContactRows`) stubs without implementing them.

## Server (`apps/server/src/modules/family/`)
- **`circle.ts`:** `loadFamilyCircle(db, userId)` computes the qualifying own-family circle in one bounded, cycle-safe recursive CTE (ADR 0001 §6). The result includes `close` (parents, partners, children: the WP-4.3 photo editors).
- **`writes.ts`:** transactional helpers shared by the admin and member routes:
  - `createPersonTx` (optional `relateTo`), `updatePersonTx`, `deletePersonTx`, `createRelationshipTx`, `deleteRelationshipTx`.
  - Each one runs `personDatesIssue()` on the **merged** row, writes a `person_revisions` row and an audit row in the caller's transaction, and sets `updated_by_user_id`.
  - WP-4.5 can reuse them.
- **`revisions.ts`:** the snapshot builders (an explicit column list, no keys or contacts), `insertRevision`, the history and activity queries (keyset by `(created_at, id)`, compared in SQL), the purge, and the one-year retention job (`purgeExpiredRevisions`, a timer in `index.ts` like the other cleanups).
- **`revert.ts`:** "Deshacer". It runs under the tree lock with the revision row locked. It returns 409 when the revision is already reverted, not revertible (photo or revert rows), or stale (the tree changed since). It re-runs `personDatesIssue()` and the link checks, and re-adds edges through the normal cycle and 2-parent checks.
  - Undoing a `person.create` also removes the edges created with it.
  - Undoing a `person.delete` restores the edges deleted with it. Siblings are matched by the same transaction timestamp, compared in SQL.
- **`details.ts`:** the `PersonDetails` builder, with `canEdit`, `canEditPhoto`, `canAddRelative`, `canDelete`, and `isLinked` under the unlisted rule.
  - The photo comes from `resolvePersonPhoto`, with `avatarKey: null` when hidden.
  - Contacts come from the WP-4.4 stubs, only for linked, listed, active accounts.
- **`personPhotoObjects.ts`:** an interim helper. The admin person delete removes the bucket objects after the commit: the current derivatives plus the pending `person_photo_uploads` keys. To be replaced by WP-4.3's helper (see the backlog).
- **Routes:**

  | Route | Who | Notes |
  |---|---|---|
  | `GET /api/family/people/:id` | verified member | `PersonDetails` |
  | `POST /api/family/people` | verified member | `memberCreatePersonInputSchema`; `relateTo` in the circle (403 `FAMILY_NOT_IN_CIRCLE`); member edge |
  | `PATCH /api/family/people/:id` | verified member | self or circle; 403 `PERSON_LINKED_TO_OTHER` / `FAMILY_NOT_IN_CIRCLE` |
  | `DELETE /api/family/people/:id` | verified member | creator only (403 `NOT_CREATOR`), unlinked (403 `PERSON_LINKED_TO_OTHER`), only the edges made with it (409 `PERSON_HAS_RELATIONSHIPS`) |
  | `POST /api/admin/people` | admin | `adminCreatePersonInputSchema`, `relateTo` optional |
  | `PATCH /api/admin/people/:id` | admin | `adminUpdatePersonInputSchema`; merged dates; no silent re-link (409) |
  | `DELETE /api/admin/people/:id[?purgeHistory=true]` | admin | photo objects, invite revocation, optional purge |
  | `GET /api/admin/people/:id/revisions` | admin | the "Historial"; also after the delete |
  | `POST /api/admin/revisions/:revisionId/revert` | admin | "Deshacer" → the `person.revert` revision |
  | `POST /api/admin/people/:id/revisions/purge` | admin | `{ confirm: true }` → `{ deleted }` |
  | `GET /api/admin/family/activity` | admin | the global feed; `actorUserId`, `action`, keyset cursor |

- **Behaviour on every route:**
  - Member writes share one 60/hour/user limiter (`extraRateLimitHook`), including `PATCH /api/family/me`.
  - Every family read keeps `requireVerifiedEmail`.
- **Privacy:** `toPerson` uses the viewer's circle, so living people's birth year, date and birthplace go only to self, admins and the qualifying circle. The tree focus, the search and `PersonDetails` all follow this. Bio is shown on the verified-only reads.

## Contracts (`packages/types/src/family.ts`, additive)
- `PersonDetails.canAddRelative?` and `canDelete?` are optional UX hints.
- `adminDeletePersonQuerySchema` (`purgeHistory`).
- `FamilyActivityItem`, `familyActivityItemSchema`, `familyActivityQuerySchema`.
- The deprecated `createPersonInputSchema`/`updatePersonInputSchema` are removed (backlog item), and `admin.test.ts` now uses the admin schemas.

## Web (`apps/web/src/features/family/`)
- **Tree (`/arbol/:personId?`):**
  - Bands get "Agregar pareja", "Agregar hijo/a" and "Agregar padre o madre" when `canAddRelative` is set, or for admins. The parent button hides at two parents.
  - "Editar" / "Editar mis datos" appears when `canEdit` is set. It replaces the old self-edit sheet, which is deleted.
  - "Eliminar" appears when `canDelete` is set, behind a confirmation.
  - The "Detalles" accordion (`<details>`) shows dates, birthplace and bio, plus the photo and contacts slots, each only when present.
  - "Ver más" loads depth 4, with "Bisabuelos" and "Tatarabuelos" bands when non-empty.
- **One sheet (`AddRelativeDialog`, lazy-loaded):**
  - Admins search the tree to link an existing person (`POST /admin/relationships`), **or** use "Crear nueva persona", pre-filled from the search (`POST /admin/people` with `relateTo`).
  - Members only create (`POST /family/people`). A note says: "¿Ya está en el árbol? Pídele a un administrador que los conecte."
- **`PersonFields`:** name, nickname, branch, birth year **or** full date, birthplace, "Ya falleció" (which reveals the death year/date), and bio. A date fills its year. Clearing or changing a year clears its date, and un-ticking "Ya falleció" clears the death data.
- **Admin:**
  - The person page has a "Datos" / "Historial" tab. The history offers "Deshacer" per row and "Borrar historial" behind a confirmation sheet.
  - The delete section has a "Borrar también el historial" checkbox.
  - `PersonForm` uses the new admin schemas and fields.
  - A new "Actividad del árbol" page (`/admin/familia/actividad`, linked from Panel) has an action filter, a tap on an actor's name for "Solo cambios de …", "Cargar más", and "Deshacer".
- **Other WPs' files touched:**
  - `features/admin/components/AdminLayout.tsx` gets one `ADMIN_SECTIONS` row.
  - `PersonSearch` gets an `onQueryChange` prop.
  - No shared UI or `baseApi.ts` edits: the revision lists use a reserved `Person` tag id.

## Decisions
- **The circle includes the member's own additions.** These are the people a member created and attached, by their own member edge, to someone in their circle (bounded). Without this, a member could not fix the sibling or grandchild they just added. It cannot widen to anybody else's relatives, because member edges always join a person the member created to someone already in their circle. This is recorded in ADR 0001 §6.
- **Admins on the member write routes get full scope**, with admin edges. The tree UI sends admins to the admin routes anyway.
- **Member delete "only its own edges" means edges created in the same transaction as the person.** These are member edges by that member with the same `created_at`, compared in SQL. A later addition hanging off it blocks the delete (409).
- **`purgeHistory` on delete:** the purge runs first and the delete records no revision, so a removal request leaves no snapshot. It is still audited, with ids and counts only.
- **Undo restores as the admin's:** restored people and edges are recorded as admin-made (`created_by_member = false`), because the admin chose to restore them.
- **Relationship revisions are about one person:** `personId` is the new person for `relateTo`, otherwise `toPersonId`. The per-person history also matches `fromPersonId`/`toPersonId`, so both endpoints see the change.
- **No silent re-link:** an admin PATCH that moves a linked person to another account returns 409 `PERSON_LINKED_TO_OTHER` on `userId`. Unlink first. This came from the WP-4.2 review.
- **Pending invites:** a person delete revokes the person's pending invites in the same transaction, after the person row lock (person, then invite, like the invite accept). Audited `invite.revoked` with `reason: "person_deleted"`.
- **Accepted risk:** `canEdit: false` / 403 `PERSON_LINKED_TO_OTHER` can reveal to the qualifying circle that an unlisted relative has an account. This is accepted risk A13 (WP-4.0).

## Review fixes (PR #46, Security)
- **L1:** the own-additions walk (`circle.ts`) covers unlinked people only and stops at linked ones. Once an addition gets an account, the creator loses its living dates and birthplace and the right to edit it, unless it is in the circle by the normal rules (their own child over a qualifying edge). Additions hanging off it fall out of the circle too.
- **L2:** on a member's own linked node, `deceased`, `deathYear` and `deathDate` are admin-only. `PATCH /api/family/people/:id` answers 403 `ADMIN_ONLY_FIELD` (new `FamilyIssueCode`). `PATCH /api/family/me` now accepts the same self field set (name, nickname, branch, birth year/date, birthplace, bio) and strips death data. The edit sheet hides "Ya falleció" and the death fields for the member's own node. Documented in ADR 0001 §6.
- **UI:** "Deshacer" now opens a confirmation sheet with "Al deshacer, la persona y sus relaciones quedarán registradas como agregadas por un administrador."
- **Tests:** the circle and permission rules (L1, 2 tests), the admin-only death fields and the aligned `/me` (L2, 4 tests), a route-matrix rule probe (`ADMIN_ONLY_FIELD`, with state), an updated `/me` mass-assignment probe, RTL tests for the hidden fields and the revert confirmation, and the e2e journey 13 confirm step.

## Review fixes (PR #46, Tech Lead)
- **Lock order:** every family write locks the family tree first, then the person row, then invites, the same order invite accept uses (person, then invite). The admin person delete, admin PATCH and the self edit now take the tree advisory lock before locking the person row. A race test (admin delete against a member edit and a self edit, 8 rounds) reproduces the 500 deadlock on the old order and passes on the new one. The #44 invite race tests still pass.
- **Undo of an addition:** undoing a `person.create` goes through the same cleanup as a delete. Pending invites are revoked in the transaction (`revokePendingInvites`, shared with `deletePersonTx`), and tree-photo objects are deleted after the commit.
- **After merging PR #45 (WP-4.4):** the "Detalles" accordion renders contacts with WP-4.4's `ContactList`.

## Tests
- **Server:**
  - `member-editing.test.ts` (23): the circle rule (depth bound, a planted non-qualifying member edge, fail-closed when the creator is gone); create, edit and delete with every error code and state checks; no sequence of member requests reaches someone else's relatives; `userId` and existing-to-existing edges → 400, and no member relationship route; `PersonDetails` privacy; the rate limit; merged dates on `PATCH /family/me`.
  - `revisions.test.ts` (21): admin writes with revisions; merged dates; no silent re-link; revert of update, create, delete and relationships, including stale, already-done, photo and invalid snapshots; purge; delete with photo objects, `purgeHistory` and invite revocation; the activity feed (pages, filters); admin-only access; snapshots without emails or keys; retention.
  - The route matrix has rows for the 3 member and 4 admin routes, with IDOR, rule and mass-assignment probes and before/after state.
  - The PII scan now checks a living person's date and birthplace outside the circle (including a planted member edge), revision routes 403 for members, and admin revision bodies.
- **Web:**
  - `FamilyEditing.test.tsx` (12): the accordion and its slots, add buttons by permission, member create and the year-follows-date rule, clearing, the server's 403 reason, validation, member delete, the admin link-existing and create-pre-filled flows, and depth-4 bands.
  - `AdminHistory.test.tsx` (7): the history, revert, purge, delete with and without purge, and activity filters and pagination.
  - `personForm.test.ts` (6).
  - Updated: `FamilyTreePage.test.tsx`, `AdminFamily.test.tsx` and `tree.test.ts`.
- **E2E:** journey 13 in `tests/e2e/familyEditing.spec.ts` (iPhone, Pixel, desktop):
  - An admin adds Beto's wife, daughter and mother without accounts, then the mother's parents, a great-grandparent and a great-great-grandparent. "Ver más" shows "Bisabuelos" and "Tatarabuelos".
  - Beto adds his own child.
  - The admin finds it in "Actividad del árbol", undoes it, and it disappears from Beto's tree.
  - The 320/375 gates now include `/admin/familia/actividad`.
- **Screenshots** in `docs/ux/screenshots/t6/`, at 375 and 1280, fictional data: `editar-arbol`, `agregar-admin`, `agregar-formulario`, `agregar-miembro`, `detalles`, `tatarabuelos`, `actividad`, `historial`.

## Verification
See the final report of the run. The suite: `pnpm lint`, `pnpm turbo run typecheck --force`, `pnpm test`, `pnpm build` and `pnpm e2e` (journeys on every project, the mobile gates and Lighthouse), after merging `origin/main`.
