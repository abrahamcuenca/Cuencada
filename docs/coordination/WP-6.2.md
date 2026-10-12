# WP-6.2 Photo tags, hearts and comments [SEC]
Owner: Senior full-stack JS (BE + FE) with the UI/UX designer · Reviewers: TL, Security · Branch: `wp/6.2-photo-social` · PR: (not opened)

Based on `origin/main` @ 83dbb88 (WP-6.0 contracts + migration 0010). Rules: ADR 0001 §8 (binding); interfaces: `docs/coordination/WP-6.0.md` § "WP-6.2". No migration and no contract change.

## Server (`apps/server/src/modules/social/`)
Registered by the media module (`media/index.ts`), so photos and their social data share one plugin tree and one scope rule.

| Route | Notes |
|---|---|
| `GET /api/media/:id/detail` | `findViewableRecord` (404 first); item with counts, visible tags, like state, live comment count, first comment page (oldest first), `canTag` (visible tags < 30). Admin outside a participants event: audited like `GET /api/media/:id`. |
| `GET /api/media/:id/tag-candidates` | name/nickname `ILIKE` (escaped), the caller's own person first; photo under the unlisted/disabled rules (`presignPersonAvatars`). 120/h. |
| `POST /api/media/:id/tags` | lock the photo (`for update` under `viewableSql`, 404), then **one decision statement** (person exists + `for share`, tag count vs 30, existing tag, insert with the status `case` on the link in SQL). 201 new / 200 existing / 400 `TAG_NOT_ALLOWED` / 409 `TAG_LIMIT`. Audited `media.tagged`. 60/h. |
| `POST /api/media/tags/:id/approve` | the tagged person's user only, photo visible (404 otherwise, same message either way); idempotent; marks the `tag:{mediaId}` notification seen; audited. 120/h (shared with decline). |
| `DELETE /api/media/:id/tags/:tagId` | tagger, the tagged user (decline / "Quitar mi etiqueta"), the uploader (approved tags only: a pending one is invisible to them), admins; 404 otherwise; audited `media.untagged` with `by`. |
| `PUT|DELETE /api/media/:id/like` | photo `for share` under the scope; idempotent; a new heart → `photo_liked` to the uploader. 300/h. |
| `GET /api/media/:id/likes` | newest first, keyset `(created_at, user_id)`; names, avatars only for listed active members (own always), no ids. 300/h. |
| `GET|POST /api/media/:id/comments` | oldest first, keyset; `clientCommentId` replay → 200 (another photo → 409); a new comment → `photo_commented` to the uploader. 30/h. |
| `DELETE /api/media/comments/:id` | author only, through the photo's scope (404 `COMMENT_NOT_FOUND` for everyone else, admins included); scrubs the body to `''`; idempotent. |
| `POST /api/media/comments/:id/report` | live comment on a visible photo; own 403, repeat 409; audited `media_comment.reported` (no details). 20/day. |
| `DELETE /api/admin/media/comments/:id` | admin moderation; scrub + audited `media_comment.deleted` (`mediaId`, `authorUserId`). |
| `GET /api/admin/media/comment-reports` | comments with reports, newest report first; `includeDeleted`; ≤ 20 reports each. |
| `GET /api/family/people/:id/photos` | `listViewable` (`viewableSql` + published editions only) with `taggedPersonSql`; 404 for an unknown person. |

- **Counts** (`MediaItem.likeCount`, `likedByMe`, `commentCount`, `tagCount`): scalar subqueries in the same select (`socialCountColumns`, `media/socialSql.ts`) for the edition and album galleries, `GET /api/media/:id`, the admin queue and "Fotos de"; `MediaRecord.social` carries them to `toMediaItem`.
- **`moveMediaTagsTx(tx, fromPersonId, toPersonId)`** (exported by `modules/social/index.ts`) for WP-6.4's `mergePeopleTx`: moves tags, drops duplicates (approved beats pending; tie → keep's), re-pends a moved tag when keep is linked to an account other than the duplicate's (unless that account made the tag). **Call it before moving the account link** (afterwards approved tags fail closed to pending). `merge.ts` untouched.
- **Notifications:** calls WP-6.1's `notify.ts` (still the stub on main): likes and comments in the transaction, push after the commit; tag requests and their retraction from after-commit jobs (below).

## Decisions
1. **Tagger-blind tags (orchestrator, security residual).** The tagger sees their own pending tag as `approved` with `canApprove: false`, in the detail, in `tagCount` and in their "Fotos de"; only the tagged user and admins see `pending`. One visibility predicate everywhere (`tagVisibleSql`): admins all; others approved + pending ones they made or that name their own person. ADR 0001 §8 and A15 updated.
2. **No per-account timing branch on insert:** the same two statements run for every person; the `photo_tag_request` is written by an **after-commit job queued for every new tag** (the job locks the tag, re-checks pending + linked, records, pushes). Decline/removal queue a retraction job for every removed tag. Deviation from "same transaction" documented in ADR §8 and the backlog (in-process queue: lost on a crash; the tag is still visible pending to the tagged user).
3. **Residual oracles accepted** (ADR §8, A15): a decline makes the tag vanish for the tagger; re-tagging a person already pending-tagged by someone else returns that tag mapped as approved, which the caller then does not see; `TAG_LIMIT` at the boundary counts hidden pending tags (`canTag` counts visible ones).
4. **Uploader removal** covers approved tags only (a pending tag of someone else is invisible to the uploader: 404).
5. **Avatars** of comment authors and likers: own always; others only when listed in the directory and active (a missing profile counts as unlisted, fail closed). Tags and candidates use the family rules (`presignPersonAvatars`, 64 px).
6. **Approve marks the request seen** through `markNotificationSeen(tx, userId, dedupeKey)`, the helper WP-6.1 announced: WP-6.2 adds it to the `notify.ts` stub (no-op, same signature) so WP-6.1's implementation replaces it on merge.
7. **Deep links** (`usePhotoParam`, `?foto=<uuid>`, anything else ignored): `/galeria/{year}?foto=`, `/eventos/{y}/{slug}?vista=fotos&foto=` (a bare `?foto=` also opens the Fotos tab; a photo of another album loads through `/detail`), and the person "Fotos" tab. WP-6.3's `/recuerdos/{boxId}?foto=` only needs to use `usePhotoParam()` instead of `useState` for the open id; `GalleryLightbox` is unchanged. Missing and invisible photos show the same "No encontramos esa foto".
8. **Social module registered by the media module**, so `app.ts` is untouched (fewer conflicts with 6.1/6.3).

## Security
ADR 0001 §8 requirements 1, 3, 4, 8, 9, 10 for 6.2: scope first on every route (matrix probes), one locked decision for tags, remove rights, author-only delete with scrubbed bodies, rate limits, PII additions, audit ids only.

## Tests
- `modules/social/social.test.ts`: scope first (12 routes → 404 on a participants-only event photo, nothing written), the tagger-blind pending flow (tagger/third/uploader/tagged/admin views, approve rights), immediate approval (no account, self), repeat/unknown/cap, decline + re-tag, remove rights, hearts/likers (idempotent, unlisted avatar null, no ids, own avatar), likers paging, comments (idempotent replay, cross-photo 409, body limits, oldest first), author-only delete + tombstone + stored `''`, reports/queue/admin delete audit without body, unlisted comment authors, tag and candidate PII, list counts per viewer, "Fotos de" visibility, `moveMediaTagsTx` (move, dedupe, re-pend, self-tag kept).
- `modules/social/notifications.test.ts` (mocks `notify.ts`): the tag request from the job (recipient/actor/kind/target), none for unlinked/self tags, none after a decline that beats the job, retraction on decline, likes/comments to the uploader only on new rows.
- Security: `socialRouteMatrix.ts` (15 routes, principals + IDOR/rule probes), `docs/security/routes.md` regenerated, `pii-leak.test.ts` WP-6.2 case.

## Web (`apps/web`)
- **`Lightbox`** gains optional `footer` (full-width row under the caption) and `overlay` (over the measured image box, images only; pointer-transparent except the tap-to-place target); existing callers unchanged.
- **`GalleryLightbox`** loads the social layer lazily (`features/gallery/social/LightboxSocial.tsx`, ~5.9 kB gzip): heart (`aria-pressed`, optimistic, rolled back on error), "N Me gusta" → likers sheet, "Comentarios (n)" → comments sheet (bottom sheet on mobile; oldest first, "Ver más comentarios", composer with a reused `crypto.randomUUID` client id, "Eliminar" → inline confirm → "Comentario eliminado", "Reportar" with a reason, admins "Eliminar (moderación)"), "Etiquetar" (when `canTag`) → picker that shows only the server's candidates, optional "Señalar en la foto" (tap-to-place, 4 decimals), tag chips ("Esperando aprobación" only when the server says `pending`; "Quitar mi etiqueta"; remove for `canRemove`), and the "Te etiquetaron en esta foto. ¿Eres tú?" banner with one-tap Aprobar / Rechazar.
- **Grid tiles** show small heart/comment counts (hidden from screen readers).
- **Person page:** "Detalles" gets "Datos" / "Fotos" tabs; "Fotos" (`PersonPhotos`, lazy) uses `/api/family/people/:id/photos` with the same lightbox.
- **Admin `/admin/media`:** "Comentarios reportados" tab (`?cola=comments`, lazy): the queue, "Mostrar también los eliminados", open the photo, confirmed "Eliminar comentario".
- **RTK Query** endpoints in `features/gallery/social/api.ts` (reusing the existing tag types; mutations patch the cached detail and list item instead of refetching, so presigned URLs are not re-signed).
- Tests: `social/LightboxSocial.test.tsx` (15), `family/pages/PersonPhotos.test.tsx` (2), a `Lightbox` slot test, and `events/pages/EventDetailPage.test.tsx` deep links (`?vista=fotos&foto=` and bare `?foto=`, a photo of another album). `gallery/testUtils.ts` serves the social endpoints.
- e2e: `tests/e2e/photoSocial.spec.ts` (Fede uploads, hearts, tags Ana and sees a plain chip, comments; Ana opens the deep link on her phone, sees "Esperando aprobación" and approves; Fede deletes his comment → tombstone; a missing photo's deep link → not-found). Screenshots `docs/ux/screenshots/w62/` (375 and 1280: lightbox social, comments, approve banner).

## Verification
Branch tip on `origin/main` @ 83dbb88 (main had not moved; the merge is a no-op).
- `pnpm lint`: clean. `pnpm turbo run typecheck --force`: 6/6. `pnpm test`: 215 files / 2811 tests passed. `pnpm build`: ok. Initial JS 180.66 kB gzip (budget 190 kB; was ~180.6).
- `pnpm e2e` on isolated ports (API 4262, storage 4263, web 5262, DB `cuencada_w62_e2e`): 87 passed, 1 failed (`directory.spec.ts` desktop: "Clicking the checkbox did not change its state" on the profile switch, untouched by this WP; passed 3/3 on rerun); `photoSocial.spec.ts` 5/5 on all three projects; Lighthouse mobile passed.
