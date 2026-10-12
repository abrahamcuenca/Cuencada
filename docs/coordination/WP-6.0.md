# WP-6.0 Social, notifications, Memory Box, one tree: contracts + migration [SEC]
Owner: Software Architect · Reviewers: TL, Security · Branch: `wp/6.0-social-contracts` · PR: (not opened)

Based on `origin/main` @ 7f402ee (WP-5.3, migration 0009). Plan: WP-6 "Photo tags/likes/comments, one family tree, Memory Box, notifications". This WP is the schema owner for migration **0010** and adds **no routes or UI**; WP-6.1 (notifications), 6.2 (tags, hearts, comments), 6.3 (Memory Box) and 6.4 (one family tree) build on it from the interfaces below. Authorization rules: **ADR 0001 §8** (binding).

## Scope
- **Migration `0010_social_tree_memories`** (expand-only; `drizzle/0010_social_tree_memories.sql`, `meta/0010_snapshot.json`, journal). `drizzle-kit generate` after it: "No schema changes".
- **Drizzle schema:** new `db/schema/social.ts` (`media_tags`, `media_likes`, `media_comments`, `comment_reports`) and `db/schema/notifications.ts`; `memory_albums` + `media_items.memory_album_id` in `media.ts` (the two tables reference each other); `tree_link_proposals` + `family_settings` in `people.ts`.
- **Contracts** (`packages/types`): new `notifications.ts` and `social.ts` (re-exported by `chat.ts`), `memories.ts` (by `cuencadas.ts`), `treeLinks.ts` (by `admin.ts`; `family.ts` cannot re-export a module that imports it). The barrel stays frozen. Additive edits: `media.ts` (`MediaItem.memoryAlbum`, `likeCount`, `likedByMe`, `commentCount`, `tagCount`; `adminMediaQuerySchema.memoryAlbumId`), `eventRefs.ts` (`MemoryAlbumRef`), `chat.ts` (`notification` server frame), `admin.ts` (audit actions and entity types), `events.ts` (exports `singleLineTextSchema`/`cleanNullableTextSchema`, the event title/text rules, for reuse).
- **Cross-track edits:** `modules/media/service.ts` `mediaScopeSql` denies unrecognised scopes (decision 4); the `modules/notifications/notify.ts` stub (decision 17); web `features/admin/lib/labels.ts` (Spanish labels for the new audit values; `Record<AuditAction|AuditEntityType, string>` is exhaustive).
- **Docs:** ADR 0001 §8, threat model (assets, §4.10, A15), this file, backlog, runbook (rollback floor, 0010 deploy note).

## Schema (expand-only)

| Table | Columns | Constraints and indexes |
|---|---|---|
| `notifications` | `id`, `user_id` → users CASCADE, `kind`, `actor_user_id` → users SET NULL, `media_id` → media_items CASCADE, `event_id` → events CASCADE, `proposal_id` → tree_link_proposals CASCADE, `dedupe_key`, `count` (default 1), `seen_at`, `created_at`, `updated_at` | kind CHECK (5 kinds); `notifications_target_check` (photo kinds ⇒ only `media_id`; `event_added` ⇒ only `event_id`; `tree_proposal_resolved` ⇒ only `proposal_id`); `notifications_not_self_check` (`actor_user_id <> user_id`); `count >= 1`; dedupe key 1–200. Partial unique `(user_id, dedupe_key) where dedupe_key is not null`; feed `(user_id, created_at desc, id desc)`; partial unseen `(user_id, created_at desc) where seen_at is null`; `created_at` (retention); one per FK. |
| `media_tags` | `id`, `media_id` → media_items CASCADE, `person_id` → people CASCADE, `tagged_by_user_id` → users SET NULL, `status` (`pending` \| `approved`, default `pending`), `approved_at`, `x`/`y` `numeric(5,4)`, `created_at` | status enum; `(status = 'approved') = (approved_at is not null)`; both-or-neither and 0–1 CHECK; unique `(media_id, person_id)`; index `(person_id, status)`, `tagged_by_user_id`. |
| `media_likes` | PK `(media_id, user_id)`, both CASCADE, `created_at` | index `user_id`. |
| `media_comments` | `id`, `media_id` → media_items CASCADE, `author_user_id` → users SET NULL, `body`, `client_comment_id`, `deleted_at`, `deleted_by_user_id` → users SET NULL, `created_at` | `media_comments_body_check`: ≤ 1000 and (≥ 1 after `btrim`, or `''` on a deleted row: the scrubbed tombstone); deleter ⇒ deleted; partial unique `(author_user_id, client_comment_id)`; keyset `(media_id, created_at, id)`; FK indexes. |
| `comment_reports` | mirrors `media_reports`: `comment_id` → media_comments CASCADE, `reporter_user_id` → users CASCADE, `reason`, `details` | reason CHECK; details ≤ 500; unique `(comment_id, reporter_user_id)`; index reporter. |
| `memory_albums` | `id`, `title`, `description`, `cover_media_id` → media_items SET NULL, `sort_order` (default 0), `status` (default `draft`), `created_by_user_id` → users SET NULL, timestamps | title 1–120, description ≤ 2000, sort 0–1000, status enum; index `(status, sort_order, created_at)`, FK indexes. |
| `media_items` | + `memory_album_id` → memory_albums **RESTRICT** | `media_items_scope_check` → `num_nonnulls(cuencada_id, album_id, memory_album_id) = 1`; `media_items_storage_prefix_check` also accepts `memories/{uuid}` (and requires a prefix on box rows); **new** `media_items_memory_prefix_check`: a box row's prefix is exactly `memories/{memory_album_id}`; partial keyset `media_items_memory_keyset_idx (memory_album_id, created_at desc, id desc) where memory_album_id is not null`. FK and CHECKs NOT VALID → VALIDATE. |
| `tree_link_proposals` | `id`, `kind`, `from_person_id`/`to_person_id` → people **SET NULL** (decision 1), `relation`, `note`, `proposed_by_user_id` → users SET NULL, `status` (default `pending`), `resolved_by_user_id` → users SET NULL, `resolved_at`, `resolution_note`, `created_at` | kind/status enums; `relation` set iff `kind = 'relate'` (`parent_of`/`partner_of`); `from <> to`; **pending ⇒ both people set**; `(status = 'pending') = (resolved_at is null)`; notes ≤ 500; partial unique **`(proposed_by_user_id, least(from,to), greatest(from,to)) where status = 'pending'`** (per proposer, PR #56 L2); pair index `(least, greatest, status)` (admin grouping); queue `(status, created_at)`; `(proposed_by_user_id, created_at)` (daily count); FK indexes. |
| `family_settings` | `id boolean` PK default `true` CHECK `(id)`, `root_person_id` → people SET NULL, `updated_by_user_id` → users SET NULL, `updated_at` | one row, inserted by the migration. |

**Data steps:** (1) the `family_settings` row; (2) every undismissed WP-5.3 consent notice (`event_participants` with `added_by_user_id` set, `<> user_id`, `notice_seen_at is null`) → one `event_added` notification (actor = adder, `dedupe_key = event:{eventId}`, `created_at = updated_at = joined_at`). `notice_seen_at` is kept (deprecated).

### Why it is expand-only
- New tables only receive rows from new code; the migration's own data rows (settings, migrated notices) are never read by 0009-era code.
- `media_items`: a nullable column; both rewritten CHECKs are strictly wider for every row 0009-era code writes (it never sets `memory_album_id`), and the new box-prefix CHECK only constrains rows with it set. Dropped and re-added CHECKs and the FK run NOT VALID → VALIDATE inside the migration transaction (no window without a CHECK).
- 0009-era reads would let a box row through `mediaScopeSql` (`album_id is null`), but no box row can exist before WP-6.3 ships; WP-6.0's code also closes that (decision 4).
- `event_participants.notice_seen_at` is untouched, so 0009-era notice routes keep working; the copied notifications are only read by WP-6.1.

## Decisions
1. **Proposal person FKs are SET NULL, not CASCADE** (deviation from the brief). Approving a `same_person` proposal runs the merge, which deletes one of the proposal's own people: with CASCADE the approved proposal (and, through `notifications.proposal_id` CASCADE, the proposer's "aprobada" notification) would vanish inside the very transaction that approves it. SET NULL keeps resolved history (`TreeLinkProposal.from`/`to` are nullable). To keep pending proposals meaningful, a CHECK requires both people while `pending`, so person delete and merge must withdraw or re-point pending proposals first (6.4); a forgotten path fails closed (the delete fails), never silently.
2. **Deleting a comment scrubs its body** (author and admin alike): the tombstone is `{ deleted: true, body: "", author: null }`, and the DB CHECK only allows `''` on deleted rows. Data minimisation; it also makes "no deleted comment bodies" a storage guarantee, not only a response rule. Admins act on reports before deleting.
3. **Notification feed order = `created_at`, which coalescing moves.** A repeated like/comment on the same photo updates the existing `(user_id, dedupe_key)` row: `count`, `actor_user_id`, `created_at = now()`, `seen_at = null`. `updated_at` is row bookkeeping (it also moves on "mark read", so it cannot order the feed). Like `count` = likes from others on the photo at the time of the last like (recomputed, so like/unlike/like does not inflate it); comment `count` grows while unread and restarts at 1 after it was seen.
4. **`mediaScopeSql` is made exhaustive now, not in 6.3.** Migration 0010 makes box rows possible and the WP-5.3 predicate was `album_id is null or …`, which would let them through to every member. WP-6.0 rewrites it as `cuencada_id is not null or (album_id is not null and exists …)`: box rows (and any future scope) are denied to members until WP-6.3 adds an explicit published-box branch. Behaviour for edition and album rows is unchanged (`media/memoryScope.test.ts` + the existing suites).
5. **Box rows pin their prefix in the DB** (`media_items_memory_prefix_check`): `storage_prefix = 'memories/' || memory_album_id`. Stronger than the WP-5.2 shape-only CHECK, at no cost: box keys can never point at another box.
6. **`family_settings` row:** inserted by the migration, but the test harness truncates every table, so 6.4 **upserts** on write (`insert … on conflict (id) do update`) and readers treat a missing row as "no root".
7. **Tag position `numeric(5,4)`** (0.0001 of the image ≈ 1 px on a 10 000 px side); the contract uses JS numbers 0–1; `x`/`y` are absent (not null) in `MediaTag` when not placed.
8. **Tag consent (PR #56 Security L1, owner):** every person is taggable (the unlisted rule and its oracle are gone); a tag of a person linked to an account is `pending` until that user approves (`POST /api/media/tags/:id/approve`) or declines (`DELETE …/tags/:tagId`); people without accounts and self-tags are `approved` at once. The DB defaults to `pending` (fail closed). `TAG_NOT_ALLOWED` (400 `VALIDATION`, `path: "personId"`) now only means "no such person". Tagging an already-tagged person returns the existing tag (200, no new notification). Hidden members' tags show the name only.
9. **No account ids on social read models:** tags carry the person id and name; comment authors and notification actors carry `{ name, avatarUrl, isMe? }` only. Avatars follow the unlisted/disabled rules.
10. **Re-export locations** (barrel frozen): notifications + social via `chat.ts` (it imports the frame schema), memories via `cuencadas.ts` (beside events), treeLinks via `admin.ts`. Nothing imports `chat.ts`/`admin.ts`/`cuencadas.ts`, so no import cycles.
11. **`Notification` name** shadows the DOM `Notification` global inside files that import it; the web should import it as `type Notification as AppNotification` where the Web Notifications API is also used.
12. **Codes beyond the brief:** `MEMORY_ALBUM_NOT_EMPTY` (409 on box delete with live media, mirrors `EVENT_ALBUM_NOT_EMPTY`). Audit additions beyond the brief: `media_comment.reported`, `memory_album.published|hidden|reordered`, `tree_proposal.withdrawn`.
13. **One notification kind for tag consent:** `photo_tag_request` replaces `photo_tagged` (not a pending flag on `photo_tagged`): every notified tag is a request; approving marks it seen, declining or removing deletes it. People without accounts get no notification.
14. **Likers are listed** (owner): `GET /api/media/:id/likes` → `MediaLiker { name, avatarUrl, isMe }`, avatars only for listed active members; the like notification reads "Ana y {count − 1} más".
15. **Proposal uniqueness is per proposer** (PR #56 L2): `PROPOSAL_DUPLICATE` only for your own duplicate; the admin queue answers `TreeLinkProposalGroup`s (one per pair); `resolve` takes `applyToPair` (default `true`: same decision for the pair's other pending proposals of the same kind and relation).
16. **Merge undo and proposals:** an undo does **not** restore re-pointed or withdrawn proposals (nor moved tags); documented rather than refused, because they stay on keep, the same human. Backlog item.
17. **`notify.ts` stub** (`apps/server/src/modules/notifications/notify.ts`): `recordNotification(tx, { recipientUserId, actorUserId, kind, target })`, `retractNotification(tx, recipientUserId, dedupeKey)`, `pushNotifications(app, ids)` with fixed signatures and `TODO(WP-6.1)` no-op bodies, so 6.2 and 6.4 call them now.
18. **Rollback floor:** once WP-6.3 writes box rows, the code must never roll back below WP-6.0 (older `mediaScopeSql` would expose box media); recorded in `docs/deploy/runbook.md` § 5 and the 0010 deploy note.

## Interfaces for 6.1/6.2/6.3/6.4
All routes: `auth: "user"` + `config.requireVerifiedEmail: true` (admin routes `auth: "admin"`), response schemas from `@cuencada/types` (the PII guard). `:id` is a uuid. A photo the caller cannot see is **404 `NOT_FOUND`** first, on every photo route.

### WP-6.1 Notifications (`modules/notifications/`)
| Method + path | Who | Params / query / body | Response |
|---|---|---|---|
| `GET /api/notifications` | member | `notificationListQuerySchema` (`cursor`, `limit`, `unread?`) | `notificationPageSchema` (newest first; invisible targets filtered out) |
| `POST /api/notifications/read` | member | `markNotificationsReadInputSchema` (`{ ids }` ≤ 100 or `{ all: true }`) | `unreadCountSchema` |
| `GET /api/notifications/unread-count` | member | — | `unreadCountSchema` (capped at 99) |
| `GET /api/events/notices` | member | — | deprecated shim: unseen visible `event_added` notifications as `eventNoticeListSchema` |
| `DELETE /api/events/:id/notice` | member | — | deprecated shim: marks `event:{id}` seen (and sets `notice_seen_at`), 204; 404 when invisible |

- **Helpers** (`modules/notifications/notify.ts`, **stub landed in WP-6.0** with these exact signatures; 6.1 fills the bodies): `recordNotification(tx, { recipientUserId, actorUserId, kind, target: { mediaId } | { eventId } | { proposalId } }): Promise<string | null>` upserts on `(user_id, dedupe_key)` with `notificationDedupeKey` **inside the caller's transaction** (returns `null` and writes nothing when recipient = actor) and trims the recipient to `NOTIFICATIONS_PER_USER_MAX` = 500 rows (seen first, then oldest); `retractNotification(tx, recipientUserId, dedupeKey)` (untag); `pushNotifications(app, ids)` **after the commit**: loads each row through the same read model as the feed (visibility filter), then a new `ChatHub.sendToUser(userId, frame)` (iterates the hub's existing per-user connection set `byUser`; never `fanOutRoom`) with `{ type: "notification", notification, unreadCount }` (`wsServerNotificationSchema`). If the row is gone, no longer visible, or the read fails, **nothing is sent**. Failures to push are logged (ids only) and never fail the request. The actor's name and avatar are resolved at read time (an actor who became unlisted shows no avatar).
- **Callers:** event participant add (5.3 `addParticipants`, admins and organizers; not self-joins) → `event_added`; 6.2 tag/comment/like; 6.4 resolve.
- **Visibility at read time:** photo kinds join `media_items` under `viewableSql(recipient)`; `event_added` under `eventVisibleSql(recipient)`; proposals where `proposed_by_user_id = recipient`. The unread count uses the same joins.
- **Retention job:** daily, delete `created_at < now() - 180 days` (batched).
- **Web:** bell + badge (TopNav/AccountMenu, mobile header), `/notificaciones`, "Marcar todo como leído", tap-through (`?foto=<mediaId>`, `/eventos/{year}/{slug}`, the proposal), replaces 5.4's notice banner.

### WP-6.2 Tags, hearts, comments (`modules/social/`)
| Method + path | Who | Params / query / body | Response |
|---|---|---|---|
| `GET /api/media/:id/detail` | viewer | `idParamSchema` | `mediaDetailSchema` (item, tags, likes, `commentCount`, first comment page, `canTag`) |
| `GET /api/media/:id/tag-candidates` | viewer | `tagCandidatesQuerySchema` (`q`, `limit` ≤ 20) | `tagCandidateListSchema` (every person; avatar `null` for unlisted/disabled members) |
| `POST /api/media/:id/tags` | viewer | `createMediaTagInputSchema` | 201 `mediaTagSchema` (`approved` for people without accounts and self-tags, else `pending`; 200 + the existing tag if already tagged); 400 `TAG_NOT_ALLOWED` (no such person); 409 `TAG_LIMIT` |
| `POST /api/media/tags/:id/approve` | the tagged person's user | `mediaTagIdParamsSchema`, no body | `mediaTagSchema` (approved; idempotent); 404 for anyone else |
| `DELETE /api/media/:id/tags/:tagId` | tagger, uploader, tagged person's user (= decline when pending), admin | `mediaTagParamsSchema` | 204; 404 for others (a pending tag is invisible to them anyway) |
| `PUT /api/media/:id/like` | viewer | no body | `mediaLikeStateSchema` |
| `GET /api/media/:id/likes` | viewer | `mediaLikersQuerySchema` (newest first) | `mediaLikerPageSchema` (names; avatars for listed members only) |
| `DELETE /api/media/:id/like` | viewer | — | `mediaLikeStateSchema` |
| `GET /api/media/:id/comments` | viewer | `mediaCommentsQuerySchema` (oldest first) | `mediaCommentPageSchema` |
| `POST /api/media/:id/comments` | viewer | `createMediaCommentInputSchema` | 201 `mediaCommentSchema` (200 on a `clientCommentId` replay) |
| `DELETE /api/media/comments/:id` | author | `mediaCommentParamsSchema` | 204; 404 `COMMENT_NOT_FOUND` for anyone else |
| `POST /api/media/comments/:id/report` | viewer (not the author) | `reportMediaCommentInputSchema` | 204; 409 on a repeat (as media reports) |
| `DELETE /api/admin/media/comments/:id` | admin | `mediaCommentParamsSchema` | 204, audited `media_comment.deleted` |
| `GET /api/admin/media/comment-reports` | admin | `adminCommentReportsQuerySchema` | `adminReportedCommentPageSchema` |
| `GET /api/family/people/:id/photos` | member | `idParamSchema`, `mediaListQuerySchema` | `pageSchema(mediaItemSchema)`: only photos the viewer can see where the person is tagged |

- Every media list (edition, album, box, person photos, admin) fills `likeCount`, `likedByMe`, `commentCount`, `tagCount` with set-based subqueries (no N+1).
- **Tag query:** one statement locks the photo under the scope predicate, checks the person exists, counts tags against the cap and reads the person's link (→ `pending` unless it is the caller's own person); no timing branch on the account. Pending tags are filtered in SQL for everyone except the tagger, the tagged user and admins; counts and "Fotos de {persona}" use `status = 'approved'` (and, for edition photos, published editions only).
- **Notifications:** pending tag → `photo_tag_request` to the tagged person's linked user (none for people without accounts or self-tags; approve marks it seen, decline/untag retracts it); comment → `photo_commented` to the uploader; like → `photo_liked` to the uploader (unlike leaves it). Never to the actor.
- **Integrations:** 6.2 provides `moveMediaTagsTx(tx: Transaction, fromPersonId: string, toPersonId: string): Promise<{ moved: number; dropped: number }>` in `modules/social/` (moves tags to `toPersonId`, drops one that would duplicate an existing tag on the same photo, an approved one winning over a pending one; a moved tag returns to `pending` if the target is linked to a different account). **6.4 owns `mergePeopleTx`** and calls it before deleting the duplicate, counting the result in the merge revision/audit. Person delete cascades. Every social route and the person-photos route go through `mediaScopeSql`, so box photos become social exactly when 6.3 opens the published branch.
- **Web (6.2 owns all lightbox social features):** lightbox heart + count + likers sheet, tag chips ("Etiquetar", "Quitar mi etiqueta", pending chips "Esperando aprobación"; "Aprobar"/"Rechazar" for the tagged user), tap-to-place (optional), comments drawer (bottom sheet on mobile, "Eliminar" own, "Reportar", "Comentario eliminado"), `?foto=<id>` deep link, "Fotos" tab on the person page.

### WP-6.3 Memory Box (`modules/memories/`)
| Method + path | Who | Params / query / body | Response |
|---|---|---|---|
| `GET /api/memories` | member | — | `memoryAlbumListSchema` (published, by `sort_order`, then newest) |
| `GET /api/memories/:id` | member (published), admin | `idParamSchema` | `memoryAlbumDetailSchema`; 404 `MEMORY_ALBUM_NOT_FOUND` |
| `GET /api/memories/:id/media` | member (published), admin | `mediaListQuerySchema` | `pageSchema(mediaItemSchema)` with `memoryAlbum` |
| `POST /api/memories/:id/uploads` | member (published), admin | `createUploadInputSchema` | 201 `CreateUploadResponse`; confirm/patch/delete/report/social through `/api/media/:id…` |
| `GET /api/admin/memory-albums` | admin | — | `adminMemoryAlbumListSchema` (every status) |
| `POST /api/admin/memory-albums` | admin | `createMemoryAlbumInputSchema` | 201 `adminMemoryAlbumSchema` |
| `PATCH /api/admin/memory-albums/:id` | admin | `updateMemoryAlbumInputSchema` (`coverMediaId` must be a live ready item of this box, else 400) | `adminMemoryAlbumSchema` |
| `DELETE /api/admin/memory-albums/:id` | admin | — | 204; 409 `MEMORY_ALBUM_NOT_EMPTY` with live media (soft-deleted rows purged, objects deleted after the commit) |
| `PUT /api/admin/memory-albums/order` | admin | `reorderMemoryAlbumsInputSchema` (every id; `sort_order` = index) | `adminMemoryAlbumListSchema` |
| `GET /api/admin/media?memoryAlbumId=` | admin | `adminMediaQuerySchema.memoryAlbumId` | existing |

- **Storage keys** (server-generated): `storage_prefix = memories/{albumId}`; `memories/{albumId}/originals/{mediaId}.{ext}`, `memories/{albumId}/thumbs/{mediaId}.webp`, `memories/{albumId}/display/{mediaId}.{webp|mp4|mov}` (`mediaKeys(prefix, id, mime)`, add `memoryStoragePrefix(album)` to `media/files.ts`). Confirm re-derives the prefix from the box row. The leftover sweep, orphan sweep, jobs and cleanup list `memories/`.
- **`mediaScopeSql`:** add the branch `(memory_album_id is not null and exists (select 1 from memory_albums ma where ma.id = media_items.memory_album_id and ma.status = 'published'))`; keep the final deny.
- `toMediaItem` sets `memoryAlbum: { id, title }` (left join) for box rows, `null` otherwise.
- **Web:** `/recuerdos` ("Baúl de recuerdos"), box page (reuses the gallery grid, lightbox and uploader **unchanged**; the social features come from 6.2's lightbox), Panel → "Baúl de recuerdos", nav (Más, AccountMenu), Home tile.

### WP-6.4 One family tree (`modules/family/`)
| Method + path | Who | Params / query / body | Response |
|---|---|---|---|
| `POST /api/family/proposals` | member | `createTreeLinkProposalInputSchema` | 201 `treeLinkProposalSchema`; 409 `PROPOSAL_DUPLICATE` (the caller's own pending duplicate only); 429 over 20/day; 404 if a person does not exist |
| `GET /api/family/proposals` | member (own) | `treeLinkProposalListQuerySchema` | `treeLinkProposalPageSchema` |
| `DELETE /api/family/proposals/:id` | proposer | — | 204 (withdrawn); 404 for others; 409 `PROPOSAL_NOT_PENDING` |
| `GET /api/admin/family/proposals` | admin | `treeLinkProposalListQuerySchema` (pending first by default) | `treeLinkProposalGroupPageSchema` (grouped by unordered pair) |
| `GET /api/admin/family/proposals/:id` | admin | — | `treeLinkProposalSchema` (side-by-side: plus the existing `GET /api/admin/people/:id/merge-preview`) |
| `POST /api/admin/family/proposals/:id/resolve` | admin | `resolveTreeLinkProposalInputSchema` | `treeLinkProposalSchema`; merge/edge 409s leave it pending; 409 `PROPOSAL_NOT_PENDING` |
| `GET /api/family/settings` | member | — | `familySettingsSchema` |
| `GET /api/admin/family/settings` | admin | — | `familySettingsSchema` |
| `PUT /api/admin/family/settings` | admin | `updateFamilySettingsInputSchema` | `familySettingsSchema` |
| `GET /api/family/tree/extended` | member | `extendedFamilyQuerySchema` | `extendedFamilySchema` |
| `GET /api/family/overview` | member | `treeOverviewQuerySchema` (`personId?`, `depth` 1–3, default 2) | `treeOverviewSchema` |
| `GET /api/family/overview/path` | member | `treeOverviewPathQuerySchema` | `treeOverviewPathSchema` |
| `GET /api/admin/family/branches` | admin | `disconnectedBranchesQuerySchema` | `disconnectedBranchReportSchema` |

- **Resolve:** lock tree (`lockFamilyTree`) → lock the proposal row (and, with `applyToPair`, the pair's other pending rows of the same kind and relation) → re-check `pending` and both people → `mergePeopleTx` (`keepPersonId ?? to`) or `createRelationshipTx` (admin provenance; `relation` from → to) → set `approved`/`rejected` + resolver + note on each → `recordNotification(tree_proposal_resolved)` to each proposer (if any and not the resolver; the note is not in the notification) → commit → push. People in proposals are read from the current rows; `null` → "una persona eliminada".
- **Delete/merge integration (required before proposals exist), all three person-delete sites:**
  1. `deletePersonTx` (`family/writes.ts`): withdraw pending proposals naming the person (`withdrawn`, audited `reason: person_deleted`) before the delete.
  2. The revert of a `person.create` (`family/revert.ts`, the `tx.delete(people)` branch): the same withdrawal before the delete.
  3. `mergePeopleTx` (`family/merge.ts`, **owned by 6.4**): **before** deleting the duplicate, re-point its pending proposals to keep, withdrawing those that collapse to keep↔keep or collide with the same proposer's pending pair (`reason: person_merged`); call 6.2's `moveMediaTagsTx`; move `family_settings.root_person_id` to keep. The proposal being approved is set `approved` before the merge.
  - **Merge undo:** does not restore re-pointed or withdrawn proposals or moved tags (decision 16).
- **Daily limit:** count `tree_link_proposals where proposed_by_user_id = $me and created_at > now() - interval '1 day'` under `pg_advisory_xact_lock` keyed by the user (admins exempt), plus a 30/h route limiter.
- **Duplicate detection** (branches report): extend `modules/family/duplicates.ts` (`nameTokens`, `nameMatch`, `compatibleYears`) with nickname, partner-name and children-name signals (`BranchMatchReason`); components via a recursive CTE over `person_relationships` (both directions, both kinds).
- **Web:** "Es la misma persona…" / "Conectar con…" on any person, "Propuestas del árbol" queue (Aprobar runs merge or link; Rechazar with note), Panel "Raíz del árbol", "Ramas sin conectar", Tíos/Primos/Tíos abuelos bands, "Árbol completo" outline (lazy per generation, search, "ir a mí"), the "¿No ves a tu familia? Propón una conexión" CTA when `viewerConnected === false`.

## Security requirements for 6.1–6.4
ADR 0001 §8 "Security requirements for WP-6.1–6.4" (1–10) and "for the web" are binding; the threat model §4.10 lists the threats and the evidence each WP must add.

## Rollout
Migration 0010 ships with this change and is inert for 0009-era code (see "Why it is expand-only"). Because the scope predicate is exhaustive from this WP on, WP-6.3 can land its box routes without a window in which box rows are readable by members. WP-6.4 must land the delete/merge integration **with or before** the first proposal route. **Rollback floor:** once 6.3 writes any box row, never roll the code back below WP-6.0 (runbook § 5).

## Review log
- PR #56 approved (TL, Security), then amended before merge (0010 undeployed, amended in place; the migration test still starts from 0009): Security L1 → pending tags of linked people and no unlisted rule; owner → likers listed; Security L2 → per-proposer uniqueness and grouped admin queue; Security info → ADR §8 requirements (person photos from the viewable set and published editions only, one locked tag query, push sends nothing on failure, 500 notifications per user, hidden-box social data, current names in proposals, note to the proposer only, PII cases); TL → `notify.ts` stub, 6.4 owns `mergePeopleTx` with 6.2's `moveMediaTagsTx`, lightbox ownership, the three person-delete sites, merge-undo decision, rollback floor.

## Verification
- `drizzle-kit generate` after 0010: "No schema changes, nothing to migrate".
- Migration tests (`apps/server/src/db/migrations.test.ts`, "migration 0010", 6 cases), from a seeded 0009 database: media rows and `event_participants` unchanged, exactly the undismissed notice migrated (actor, key, time), the settings row, 0009-shape inserts still work, the four new/replaced `media_items` constraints validated, the partial indexes; every new CHECK accepting and rejecting (box scope and pinned prefix, box fields, notification kinds/targets/self/count/dedupe and an upsert, tags, likes, comments incl. tombstones and client ids, reports, proposals incl. the pending pair index and pending ⇔ unresolved, the single settings row); cascades (media → tags/likes/comments/reports/notifications; users → SET NULL or CASCADE; person → tags; box RESTRICT even for soft-deleted media and cover SET NULL; event → notifications; a person in a pending proposal cannot be deleted; a resolved proposal survives with the person nulled; root SET NULL; proposal → notifications).
- Scope test `apps/server/src/modules/media/memoryScope.test.ts`: a box row is 404 to members (uploader included) on GET/PATCH/DELETE/report and untouched; admins reach it.
- Contract tests: `packages/types/src/{social,notifications,memories,treeLinks}.test.ts`.
- `pnpm lint` clean; `pnpm turbo run typecheck --force` 6/6; `pnpm test` 204 files / 2680 tests passed; `pnpm build` ok. Merged `origin/main` (already up to date at 7f402ee).
- After the PR #56 amendment and merging `origin/main` @ 60045c4 (WP-5.4, PR #55): `pnpm lint` clean; `typecheck --force` 6/6; `pnpm test` 211 files / 2753 tests passed; `pnpm build` ok; `drizzle-kit generate`: no schema changes.
