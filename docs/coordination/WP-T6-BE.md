# WP-T6-BE Family tree (backend) [SEC]
Owner: Backend · Reviewers: TL, Security · Branch: wp/t6-be-family · PR: # (not opened)

Based on `origin/main` (37dd59d). T6-FE is built in parallel against the same contract.

## Scope
- `apps/server/src/modules/family/**`:
  - `repository.ts`: column sets, privacy-aware `toPerson`/`toPersonSummary`, lookups, `escapeLike`
  - `tree.ts`: `loadTreeView` (recursive CTE + 2 batch loads)
  - `relationships.ts`: `insertRelationship` under the tree lock (cycle, parent-count, duplicate, self checks)
  - `member-routes.ts`: search, person, tree, self edit
  - `admin-routes.ts`: people CRUD + account link/unlink, relationships create/delete
  - `db-errors.ts`: SQLSTATE/constraint extraction
  - tests: `member-routes.test.ts`, `admin-routes.test.ts`; fixtures in `apps/server/test/helpers/family.ts` (new file)
- `packages/types/src/family.ts`: contract amendment (below) + updated `admin.test.ts` case.
- Authorized platform fix: `apps/server/src/logging.ts` (`q`, `search` redacted from logged URLs) + `logging.test.ts`.

## Interfaces exposed
| Route | Auth | Notes |
|---|---|---|
| `GET /api/family/people?q&cursor&limit` | U + verified | `Page<PersonSummary>`. `q` matches full name, nickname or branch with escaped `ILIKE`. Ordered by `lower(full_name), id`; the keyset cursor carries **only the last id** (no name in URLs) and looks the key up; a cursor whose person was deleted ends the list. 120/min per IP |
| `GET /api/family/people/:id` | U + verified | `Person` (privacy rules below) · 404 |
| `GET /api/family/tree?personId&depth` | U + verified | `FamilyTreeView`. No `personId` → the caller's linked person (404 "no vinculada" otherwise). `depth` default 1, **clamped** to 3 |
| `PATCH /api/family/me` and alias `PATCH /api/family/people/me` | U + verified | `selfEditPersonInputSchema` (nickname, familyBranch, birthYear) on the caller's **own** node only · 404 if not linked |
| `POST /api/admin/people` | A | 201 `Person`; optional `userId` link (400 unknown account, 409 already linked) |
| `PATCH /api/admin/people/:id` | A | `Person`; `userId` links/unlinks (409 when linked to another person) |
| `DELETE /api/admin/people/:id` | A | 204; **409 while linked** (unlink first); relationships cascade (FK, tested) |
| `POST /api/admin/relationships` | A | 201 `Relationship`; 409 cycle / third parent / duplicate / mirrored partner pair; 400 self; 404 unknown person |
| `DELETE /api/admin/relationships/:id` | A | 204 · 404 |

### Tree view
- One recursive CTE walks `parent_of` up and down from the focus, `level < depth`, with a `path uuid[]` cycle guard (`not next = any(path)`). The same statement adds partners and siblings (children of the level-1 parents, minus the focus: full and half siblings). Then **one** query loads all people and **one** loads every edge whose both ends are in the set: 3 queries regardless of size (tested with a spy).
- `parents`/`children` = level 1; `extended.people` = levels 2..depth (both directions); `extended.relationships` = **every edge among all returned people, including the focus and first ring** (the client lays them out; admins get relationship ids to delete from here).
- Corrupt cyclic data inserted directly (3-cycle + 2-cycle) terminates and never returns the focus as its own relative (tested). 6-generation line tested at depths 1–3 and clamp.

### Privacy
- Admins and the member linked to the person see every field.
- **Living** people: never a death year. **Living people linked to an account hide `birthYear` from other members** (intended default; orchestrator declined a visibility flag). Living unlinked people (kids, relatives entered by admins) show the birth year only. There are no birth dates, notes or contact fields in this module.
- Deceased people show birth and death years.
- `PersonSummary` has no years at all. Response schemas strip everything else (`createdByUserId`, timestamps). `avatarUrl` is always `null` (the profile module has no `avatarUrlFor` on main yet).

### Writes
- **Cycle prevention:** every relationship insert runs in a transaction that first takes `pg_advisory_xact_lock(hashtextextended('cuencada:family-tree', 0))`, then checks: both people exist; for `parent_of`, the child is not the parent or one of its ancestors (`UNION` recursive CTE: set semantics, terminates on cycles and stays linear on shared ancestry); fewer than 2 existing parents. Concurrent A→B / B→A: exactly one 201, one 409 (5 rounds; verified that the test fails with the lock removed).
- `partner_of` is stored with `from < to` (contract); the partial unique index also rejects the mirrored pair.
- DB errors: 23505 → 409 (`Esa relación ya existe.` / `Esa cuenta ya está vinculada…`), 23514 → 400 with the field path (`deceased` for `death_year ⇒ deceased`, `deathYear` for the order check, `birthYear` on self edit), 23503 → 400/404. All messages Spanish.
- **Self edit / mass assignment:** the body schema strips unknown keys; the `set` object is built from the three whitelisted keys only, and the `UPDATE` re-checks `user_id = caller`. A body with only forbidden keys → 400 "No hay cambios". Tested with `id`, `userId`, `fullName`, `deceased`, `deathYear`, `createdByUserId`, `parents`.
- **Delete person:** one `DELETE … WHERE id = $1 AND user_id IS NULL` (no check/delete race with a concurrent link), then 404 vs 409 is decided.
- **Audit** (in the mutation's transaction, ids and field names only): `person.created` (`linkedUserId`), `person.updated` (`fields`; self edits add `self: true`), `person.user_linked` / `person.user_unlinked` (`userId`), `person.deleted`, `relationship.created` / `relationship.deleted` (`kind`, `fromPersonId`, `toPersonId`). Tests assert names never appear in audit rows or in the logs (including 409/400 error paths).

## Contract amendments (`packages/types/src/family.ts`)
- `familyTreeQuerySchema.depth` **clamps** values above `FAMILY_TREE_MAX_DEPTH` to 3 instead of rejecting them (still 400 for < 1 or non-integers). `admin.test.ts` updated accordingly. Output type unchanged (`number`).
- Doc comment: `PATCH /api/family/people/me` is an alias of the contract's `PATCH /api/family/me` (the WP brief used the former; both are served, same handler). T6-FE should use `/api/family/me`.

## Decisions
- Admin routes are `auth: "admin"` without `requireVerifiedEmail` (the seeded admin starts unverified); the member read routes do require it, so an admin who wants the tree view must verify their email.
- A living linked person's birth year is hidden from other members (accepted as the permanent default).
- Unknown person in a relationship → 404 (not in the WP-0.2 table, which lists only 409).

## Requests (→ orchestrator) and resolutions
1. **Search terms reached the logs** (resolved, orchestrator-authorized platform fix in a separate commit): `scrubUrl` in `src/logging.ts` now also redacts `q` and `search`, so `GET /api/family/people?q=<name>` (and the T5 directory search) logs `?q=[REDACTED]`. Regression test in `logging.test.ts`; the family no-names-in-logs test now covers the search route too.
2. **Birthday visibility flag:** declined. Hiding living linked people's birth years from other members is the intended privacy default.
3. **Avatars:** follow-up after T5 merges: replace `avatarUrl: null` (TODOs in `repository.ts`) with a batched presign via `avatarUrlFor`.
4. Optional: `pg_trgm` index for `ILIKE '%q%'` search if the tree grows beyond family scale.

## Verification
`pnpm lint`, `pnpm turbo run typecheck --force`, `pnpm test`, `pnpm build` green after merging `origin/main`.
