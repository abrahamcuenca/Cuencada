# WP-4.5 Admin "Fusionar personas" (merge duplicate people) [SEC]
Owner: Senior full-stack engineer (BE + FE) with the UI/UX designer · Branch: `wp/4.5-merge-people`

Based on `origin/main` 341de98 (WP-4.0, 4.1, 4.2, 4.4, 4.4b), then merged with de1b07a (WP-4.3 photos, PR #47). **Owner decision: people only, no account merge.** Plan: WP-4 "Fusionar personas". Semantics in ADR 0001 §6 ("Merge semantics").

## Scope
- **Migration `0006_person_merge_action`** (expand-only): the `person_revisions_action_check` CHECK gains `person.merge` (strictly wider list, added `NOT VALID` and validated in the same transaction). `drizzle-kit generate`: "No schema changes". Migration test from a seeded 0005 database.
- **Contracts** (`packages/types/src/family.ts`, additive):
  - `PersonRevisionAction.PersonMerge`; the `merge` snapshot (`PersonRevisionMergeSnapshot`, with `personId` = keep, `id`, `duplicatePersonId`, both person snapshots, the duplicate's creator, keep's edge ids, the duplicate's edges with their outcome and provenance, photo flags, invite and attendance ids); `MergeEdgeOutcome`.
  - `PERSON_MERGE_FIELDS`, `MergeFieldChoice`, `personMergeFieldsSchema`, `defaultMergeChoices()`, `mergedPersonValues()` (shared by server and web), `personMergeInputSchema`, `personMergePreviewQuerySchema`, `PersonMergePreview` (+ schema), `PersonMergeResponse` (+ schema).
  - `DuplicateReason`, `DuplicateCandidate`, `PossibleDuplicate` (+ schema), `familyDuplicatesQuerySchema`.
  - `FamilyIssueCode`: `MERGE_BOTH_LINKED`, `MERGE_CONFLICT`, `MERGE_NOT_REVERTIBLE`. `AuditAction.PersonMerged` (`person.merged`, `admin.ts`).
- **Server** (`apps/server/src/modules/family/`):
  - `merge.ts`: `mergePeopleTx` (plan or merge, one transaction, lock order tree → keep → duplicate → invites) and `undoMergeTx`.
  - `mergePhoto.ts`: the only place the merge touches photo objects, over WP-4.3's `personPhotoObjectKeys`/`deletePersonPhotoObjects`.
  - `duplicates.ts`: `nameTokens`, `nameMatch`, `compatibleYears`, `findPossibleDuplicates`.
  - `merge-routes.ts`:

    | Route | Who | Notes |
    |---|---|---|
    | `GET /api/admin/people/:id/merge-preview?duplicateId=` | admin | `:id` = keep; a dry run in a transaction that is always rolled back; 120/min per IP |
    | `POST /api/admin/people/:id/merge` | admin | body `{ duplicateId, fields? }` → `{ person, revisionId, revertible }`; 400 dates or same person, 404, 409 `MERGE_BOTH_LINKED` / `MERGE_CONFLICT`; 30/h per IP |
    | `GET /api/admin/family/duplicates` | admin | offset-cursor pages of `PossibleDuplicate`; 120/min per IP |

    The keep id is the `:id` segment (the same param name as the sibling `/admin/people/:id*` routes); the plan's `:keepId`.
  - `revert.ts`: "Deshacer" handles `person.merge` (`undoMergeTx`). `revisions.ts`: `person.merge` is revertible; `revisionsAboutPerson` also matches `duplicatePersonId` (history of both people, purge of the removed one). `relationships.ts`: `insertRelationship` accepts a `null` creator (re-creating an edge whose creator account is gone keeps the original provenance).
- **Web** (`apps/web/src/features/family/admin/`):
  - "Actividad del árbol" has two tabs, "Cambios" and **"Posibles duplicados"** (`?vista=duplicados`): `DuplicateList` shows pairs (name, years, branch, account yes/no, relationship count, reason badge) with **"Revisar"**; pairs where both have an account say so and offer no button.
  - Admin person page: a **"Fusionar con…"** section (`MergeWith`) opens a search sheet (`PersonSearch`, "Elegir a"), then the preview with this person kept.
  - `MergeSheet` (a bottom sheet on phones, a 720 px card from 600 px): "Se queda" / "Se quita" cards (avatar, account, relationships, tree photo), "Cambiar cuál se queda", a radio choice per differing field (side by side from 600 px; equal fields summarized), a live date check (`personDatesIssue` on `mergedPersonValues`), the relationships that move, drop or conflict (Spanish reasons), the account, photo, invites and attendance outcome, and blockers. "Fusionar" opens the confirmation ("Esta acción combina a las dos personas en una sola…"). After the merge: navigate to the kept person, toast "Fusionamos a X con Y." with **"Deshacer"**.
  - `RevisionList`: "Fusionó a dos personas: «duplicado» en «persona»"; the undo confirmation for a merge explains that the two people are split again.
  - RTK: `getFamilyDuplicates`, `getMergePreview` (never cached), `mergePeople`.
- **Docs:** ADR 0001 §6 (merge semantics, codes), threat model (2 rows), backlog (WP-4.5 follow-ups), `docs/security/routes.md` (regenerated).

## Decisions
- **Undo: full, including a moved account link.** The duplicate is re-created **with its old id** (not a new one), so its history, invites and anything else that still names it line up again; the account link moves back from keep. Conditions (409 otherwise, same spirit as 4.1's stale rule): keep still has exactly the merged values, edges and photo, there is no later revision about either person, and the duplicate's id is free (`MERGE_NOT_REVERTIBLE`, practically unreachable with UUIDs). Restored edges keep their original id and provenance, and go through the cycle and 2-parent checks again. Not restored: a losing tree photo (deleted when both had one), dropped pending uploads, and revoked invites (they stay revoked, naming the duplicate again). Moving the link back is safe because nothing about either person changed since; the account's sessions are untouched (they are by user, not person).
- **Moved edges keep their id, creator and `created_by_member`** (re-inserted under the tree lock with the same id). Provenance stays honest for the circle rule: a member edge that qualified because its creator created the duplicate no longer qualifies on keep unless that member also created keep (fail closed); an admin can re-create it.
- **Pending photo uploads are dropped, not moved.** WP-4.3 keys uploads (and their derivatives) by person id, so a moved row would point at the wrong path; a pending upload is an in-flight edit of the removed person. Their objects are deleted after the commit with the losing photo. The moved photo's derivatives are never in that list.
- **Invites:** every invite of the duplicate ends up naming keep (history). A pending one stays pending only when keep could still be invited (unlinked, living, no pending invite of its own: WP-4.2's one-pending rule), otherwise it is revoked and audited (`reason: "person_merged"`).
- **Attendance** (`cuencada_attendance`, the other `people.id` FK): moved, or dropped where keep already attended that edition (re-created by the undo). `person_revisions.person_id` is left to the FK (`SET NULL`); the snapshots keep the duplicate's id and the undo re-points those rows.
- **Preview = rolled-back dry run** of the same code (`mergePeopleTx(..., { dryRun: true })` inside a transaction that throws a sentinel), so the conflicts it lists are exactly the merge's. It takes the tree lock briefly, like any family write.
- **Defaults never break the date rules by themselves:** a full date is taken from the duplicate only when it falls in the resulting year; `deceased` only when the duplicate says the person died. Mixed choices can still break them: the sheet shows "Revisa las fechas: …" and disables "Fusionar", and the server answers 400.
- **Duplicates:** in memory over the whole tree (family scale), bucketed by the first two words. "Similar name" = one extra trailing word (a second surname), the shorter name having at least two words. Suggested keep: the invite's requested person for a fallback, else more relationships, then the older person.
- E2E names are "Lucía Arias {Apellido}" (+ " Peña" as typed by the invitee), not "Lucía {Apellido}", which is the seeded deceased grandparent (WP-4.3) and would have formed extra pairs.

## Security
- Admin-only: matrix rows for the three routes (members 403, anonymous 401, …). Probes as a member with before/after state: merging another member's linked person into an unlinked one (IDOR), merging a relative into one's own linked person (rule), extra `userId`/`fields.userId` (mass assignment): all 403, nothing changes.
- PII scan: member 403 on the preview and the pairs (no birthplace in the body); admin preview and pairs carry no emails, keys or tokens.
- Audit: `person.merged` with ids and counts; link changes and revoked invites audited with ids. Snapshot and audit contents are tested (no emails, keys, names in the audit).
- Rate limits: merge 30/h per IP; preview and pairs 120/min per IP.
- Threat model: new **E/T (WP-4.5)** and **I (WP-4.5)** rows.

## Tests
- **Server** `merge.test.ts` (20): the invite race (link moves, blanks filled, member edge moved with id/creator/flag, duplicate edge dropped, attendance moved/dropped, revision and audit contents, member sees the merged person); per-field choices and a 400 on mixed dates (nothing changes); an explicit kept blank; `MERGE_BOTH_LINKED` (state unchanged) and keep-linked merges; `MERGE_CONFLICT` for a cycle and a third parent (ids in the details, state unchanged); a keep↔duplicate link dropped; opposite concurrent merges (4 rounds: one 200, one 404); 400/404 inputs and strict bodies; photo moved, pending uploads dropped, losing photo objects deleted after the commit; invites moved, revoked when keep is linked, history kept; admin-only and the rate limit; preview (sides, defaults, edges, account, nothing changed) and preview conflicts/blockers; full undo (people, edges with provenance, attendance, invites, second undo 409); photo moved back by the undo; stale undo after an edit or a new relative (409, nothing changes); history of both people and the purge of the removed one; possible duplicates (accents/case/spaces, second surname, years, one-word names, invite fallback, both linked, no account ids, pagination, bad cursor).
- `duplicates.test.ts` (3), `migrations.test.ts` (migration 0006), contracts `familyMerge.test.ts` (5) and the issue-code list in `family.test.ts`.
- Security: `routeMatrix.ts` (3 rows, 4 probes), `pii-leak.test.ts`, `routes.md`.
- **Web** `AdminMerge.test.tsx` (7, RTL + MSW, `testing/mergeFixtures.ts`): helpers (values, dates, pairs, the merge history row, the confirm text); "Posibles duplicados" → "Revisar" → choices → "Fusionar" → confirmation → POST body with the choices → kept person page → toast "Deshacer" → revert; blockers and conflicts disable "Fusionar"; the live date check; a server 409 shown in the sheet; the empty state; "Fusionar con…" search, preview with this person kept, and "Cambiar cuál se queda".
- **E2E** journey 14 (`tests/e2e/mergePeople.spec.ts`, iPhone 13, Pixel 7, desktop): the admin adds "Lucía Arias {Apellido}" as the seeded parent's daughter; Lucía joins with a shared link as "Lucía Arias {Apellido} Peña" (a new, linked person); the admin gives that person a partner; "Posibles duplicados" lists the pair; the preview shows the partner moving and the account moving; confirm; the admin list has one Lucía; Lucía verifies her email and sees herself in the tree with her parent and her partner; the admin undoes the merge from "Actividad del árbol" and both people are back (Lucía's tree opens on her own person again). Mobile gate `admin-duplicados` (320/375, axe).
- **Screenshots** (`docs/ux/screenshots/t6/`, 375 and 1280, fictional data): `posibles-duplicados`, `fusionar-vista-previa`, `fusionar-confirmar`.

## Verification
See the final report of the run: `pnpm lint`, `pnpm turbo run typecheck --force`, `pnpm test`, `pnpm build` and `pnpm e2e` (isolated ports 3550/3551/4550 and the `cuencada_w45_e2e` database), after merging `origin/main`.
