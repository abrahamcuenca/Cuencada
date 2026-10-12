/**
 * People tags on photos (WP-6.2, ADR 0001 §8 "Tags").
 *
 * Consent: a tag of a person linked to an account is `pending` until that
 * user approves it; people without accounts and self-tags are `approved` at
 * once. Visibility is one predicate (`tagVisibleSql`): approved tags for
 * every viewer of the photo, a pending tag only for its tagger, the tagged
 * user and admins.
 *
 * **Security residual (WP-6.2, orchestrator decision): the tagger must not
 * learn whether the tagged person has an account.** So:
 * - the mapper shows the tagger their own pending tag exactly like an
 *   approved one (`status: "approved"`, `canApprove: false`); only the tagged
 *   user and admins see `pending`;
 * - the insert runs the same statements whatever the person's account state
 *   (lock the photo, then one decision statement), and the
 *   `photo_tag_request` notification is written by a background job queued
 *   for **every** new tag (the job decides), never on the request path;
 * - removing or declining a tag queues the same retraction job for every
 *   tag, so neither path has a per-account timing branch.
 */
import {
  AuditAction,
  MEDIA_TAGS_MAX,
  type MediaTag,
  MediaTagStatus,
  NotificationKind,
  notificationDedupeKey,
  SocialIssueCode,
  type TagCandidate
} from "@cuencada/types";
import { and, asc, eq, ilike, inArray, or, type SQL, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { mediaTags, notifications, people, profiles, users } from "../../db/schema/index.js";
import { type DbOrTx, recordAudit, type Transaction } from "../../lib/audit.js";
import { AppError, isAppError } from "../../lib/errors.js";
import {
  escapeLike,
  type PersonViewRow,
  personViewColumns,
  presignPersonAvatars,
  selectPersonViews,
  type Viewer as FamilyViewer
} from "../family/repository.js";
import type { Viewer } from "../media/service.js";
import { tagVisibleSql } from "../media/socialSql.js";
import { pushNotifications, recordNotification, retractNotification } from "../notifications/notify.js";
import { AvatarSize } from "../profile/index.js";
import { type LockedMedia, lockViewableMedia } from "./shared.js";

const TAG_NOT_ALLOWED_MESSAGE = "No encontramos a esa persona.";
const TAG_LIMIT_MESSAGE = `Esta foto ya tiene ${MEDIA_TAGS_MAX} personas etiquetadas.`;
const TAG_NOT_FOUND_MESSAGE = "No encontramos esa etiqueta.";

/** A tag row joined to its person (and the person's linked profile/account). */
interface TagRow {
  id: string;
  mediaId: string;
  taggedByUserId: string | null;
  status: MediaTagStatus;
  x: string | null;
  y: string | null;
  person: PersonViewRow;
}

const tagColumns = {
  id: mediaTags.id,
  mediaId: mediaTags.mediaId,
  taggedByUserId: mediaTags.taggedByUserId,
  status: mediaTags.status,
  x: mediaTags.x,
  y: mediaTags.y,
  person: personViewColumns
};

function familyViewer(viewer: Viewer): FamilyViewer {
  return { id: viewer.id, role: viewer.role };
}

/**
 * Read tags (with their people) matching `where`, ordered by creation.
 * Callers add {@link tagVisibleSql} unless they deliberately read a tag the
 * viewer may not see (never returned as such).
 */
async function selectTags(db: DbOrTx, where: SQL | undefined): Promise<TagRow[]> {
  return db
    .select(tagColumns)
    .from(mediaTags)
    .innerJoin(people, eq(people.id, mediaTags.personId))
    .leftJoin(profiles, eq(profiles.userId, people.userId))
    .leftJoin(users, eq(users.id, people.userId))
    .where(where)
    .orderBy(asc(mediaTags.createdAt), asc(mediaTags.id));
}

/**
 * Map tags for `viewer` (see the module comment for the status rule).
 * `MediaTag.person` carries the person id and name, plus the photo under the
 * unlisted/disabled rules (an unlisted or disabled member: name only).
 */
async function toMediaTags(
  app: FastifyInstance,
  rows: readonly TagRow[],
  viewer: Viewer,
  uploaderId: string | null
): Promise<MediaTag[]> {
  const avatars = await presignPersonAvatars(
    { storage: app.storage, log: app.log },
    rows.map((row) => row.person),
    familyViewer(viewer),
    AvatarSize.Small
  );
  const admin = viewer.role === "admin";
  return rows.map((row): MediaTag => {
    const isMe = row.person.userId !== null && row.person.userId === viewer.id;
    // [SEC] Only the tagged user and admins learn that a tag is pending.
    const status = admin || isMe ? row.status : MediaTagStatus.Approved;
    const position = row.x === null || row.y === null ? {} : { x: Number(row.x), y: Number(row.y) };
    return {
      id: row.id,
      person: { id: row.person.id, name: row.person.fullName, avatarUrl: avatars.get(row.person.id) ?? null },
      ...position,
      status,
      isMe,
      canRemove: admin || isMe || row.taggedByUserId === viewer.id || (uploaderId !== null && uploaderId === viewer.id),
      canApprove: isMe && row.status === MediaTagStatus.Pending
    };
  });
}

/**
 * Tags of one photo the viewer may see (callers checked the photo first).
 *
 * @param uploaderId - The photo's uploader (remove rights).
 */
export async function listVisibleTags(
  app: FastifyInstance,
  db: DbOrTx,
  mediaId: string,
  viewer: Viewer,
  uploaderId: string | null
): Promise<MediaTag[]> {
  const rows = await selectTags(db, and(eq(mediaTags.mediaId, mediaId), tagVisibleSql(viewer)));
  return toMediaTags(app, rows, viewer, uploaderId);
}

/** Result of {@link createTag}. */
export interface CreateTagResult {
  tag: MediaTag;
  /** `true` → 201 (a new tag), `false` → 200 (the person was already tagged). */
  created: boolean;
}

interface TagDecisionRow extends Record<string, unknown> {
  person_found: boolean;
  tag_count: number;
  existing_id: string | null;
  inserted_id: string | null;
}

/**
 * Tag `personId` in the photo [SEC] (ADR 0001 §8 requirement 3).
 *
 * 1. Lock the photo under the viewer's scope (`for update`; 404 when not
 *    visible). Concurrent tags of one photo serialize here, so the cap
 *    cannot be overrun.
 * 2. **One decision statement**: the person exists (row share-locked, so a
 *    merge cannot move it meanwhile), the photo's tag count against
 *    {@link MEDIA_TAGS_MAX}, the existing tag, and the insert, whose status
 *    comes from the person's link (`pending` unless unlinked or the caller's
 *    own person) inside SQL: the same statements run for every person.
 * 3. On insert: audit, then queue the notification job (for every new tag).
 */
export async function createTag(
  app: FastifyInstance,
  input: { mediaId: string; personId: string; x?: number; y?: number },
  viewer: Viewer,
  ip: string
): Promise<CreateTagResult> {
  const outcome = await app.db.transaction(async (tx) => {
    const media = await lockViewableMedia(tx, input.mediaId, viewer, "update");
    const x = input.x ?? null;
    const y = input.y ?? null;
    const [decision] = await tx.execute<TagDecisionRow>(sql`
      with p as (
        select ${people.id} as id, ${people.userId} as user_id from ${people} where ${people.id} = ${input.personId} for share
      ),
      c as (select count(*)::int as n from ${mediaTags} where ${mediaTags.mediaId} = ${media.id}),
      e as (select ${mediaTags.id} as id from ${mediaTags} where ${mediaTags.mediaId} = ${media.id} and ${mediaTags.personId} = ${input.personId}),
      ins as (
        insert into ${mediaTags} (media_id, person_id, tagged_by_user_id, status, approved_at, x, y)
        select ${media.id}, p.id, ${viewer.id},
          case when p.user_id is null or p.user_id = ${viewer.id} then 'approved' else 'pending' end,
          case when p.user_id is null or p.user_id = ${viewer.id} then now() else null end,
          ${x}::numeric, ${y}::numeric
        from p, c
        where c.n < ${MEDIA_TAGS_MAX} and not exists (select 1 from e)
        on conflict (media_id, person_id) do nothing
        returning id
      )
      select exists (select 1 from p) as person_found, (select n from c) as tag_count,
        (select id from e) as existing_id, (select id from ins) as inserted_id
    `);
    if (decision === undefined || !decision.person_found) {
      throw new AppError("VALIDATION", TAG_NOT_ALLOWED_MESSAGE, {
        details: [{ path: "personId", message: TAG_NOT_ALLOWED_MESSAGE, code: SocialIssueCode.TagNotAllowed }]
      });
    }
    const tagId = decision.inserted_id ?? decision.existing_id;
    if (tagId === null) {
      throw new AppError("CONFLICT", TAG_LIMIT_MESSAGE, {
        details: [{ path: "personId", message: TAG_LIMIT_MESSAGE, code: SocialIssueCode.TagLimit }]
      });
    }
    const [row] = await selectTags(tx, eq(mediaTags.id, tagId));
    if (row === undefined) throw new Error("social: decided tag vanished");
    const created = decision.inserted_id !== null;
    if (created) {
      await recordAudit(tx, {
        actorUserId: viewer.id,
        action: AuditAction.MediaTagged,
        entityType: "media",
        entityId: media.id,
        metadata: { tagId, personId: input.personId, placed: input.x !== undefined, status: row.status },
        ip
      });
    }
    return { row, created, media };
  });

  if (outcome.created) queueTagRequestNotification(app, outcome.row.id);
  // An existing tag the caller cannot see (someone else's pending tag of this
  // person) is answered like their own: mapped as approved (see toMediaTags).
  const [tag] = await toMediaTags(app, [outcome.row], viewer, outcome.media.uploadedByUserId);
  if (tag === undefined) throw new Error("social: tag mapping failed");
  return { tag, created: outcome.created };
}

/**
 * Background job (after the commit, off the request path): if the tag is
 * still pending and its person is linked to an account other than the
 * tagger, record the `photo_tag_request` notification under the tag's row
 * lock, then push it. Queued for every new tag so the request path never
 * branches on the person's account.
 */
function queueTagRequestNotification(app: FastifyInstance, tagId: string): void {
  app.jobs.enqueue("social.tag_request", async () => {
    const ids = await app.db.transaction(async (tx) => {
      const [tag] = await tx
        .select({ mediaId: mediaTags.mediaId, taggedByUserId: mediaTags.taggedByUserId, userId: people.userId })
        .from(mediaTags)
        .innerJoin(people, eq(people.id, mediaTags.personId))
        .where(and(eq(mediaTags.id, tagId), eq(mediaTags.status, MediaTagStatus.Pending)))
        .for("update", { of: mediaTags })
        .limit(1);
      if (tag === undefined || tag.userId === null) return [];
      const id = await recordNotification(tx, {
        recipientUserId: tag.userId,
        actorUserId: tag.taggedByUserId,
        kind: NotificationKind.PhotoTagRequest,
        target: { mediaId: tag.mediaId }
      });
      return id === null ? [] : [id];
    });
    if (ids.length > 0) await pushNotifications(app, ids);
  });
}

/**
 * Background job: delete the tagged user's `photo_tag_request` for the photo
 * (queued for every removed tag; nothing to do for people without accounts).
 */
function queueTagRequestRetraction(app: FastifyInstance, mediaId: string, personUserId: string | null): void {
  app.jobs.enqueue("social.tag_retract", async () => {
    if (personUserId === null) return;
    await app.db.transaction(async (tx) => {
      await retractNotification(tx, personUserId, notificationDedupeKey.tag(mediaId));
    });
  });
}

/**
 * The tagged person's user approves a pending tag (idempotent). Anyone else,
 * or a photo the caller cannot see: 404. Marks the tag request seen.
 */
export async function approveTag(app: FastifyInstance, tagId: string, viewer: Viewer, ip: string): Promise<MediaTag> {
  const outcome = await app.db.transaction(async (tx) => {
    const [found] = await tx
      .select({ mediaId: mediaTags.mediaId })
      .from(mediaTags)
      .innerJoin(people, eq(people.id, mediaTags.personId))
      .where(and(eq(mediaTags.id, tagId), eq(people.userId, viewer.id)))
      .limit(1);
    if (found === undefined) throw tagNotFound();
    // Scope first: the photo must be visible to the tagged user (404 otherwise).
    const media = await lockViewableMedia(tx, found.mediaId, viewer, "update").catch((error: unknown) => {
      // Same answer as a missing tag: nothing tells the two apart.
      if (isAppError(error) && error.code === "NOT_FOUND") throw tagNotFound();
      throw error;
    });
    const approved = await tx
      .update(mediaTags)
      .set({ status: MediaTagStatus.Approved, approvedAt: app.clock.now() })
      .where(and(eq(mediaTags.id, tagId), eq(mediaTags.status, MediaTagStatus.Pending)))
      .returning({ personId: mediaTags.personId });
    const changed = approved[0];
    if (changed !== undefined) {
      await tx
        .update(notifications)
        .set({ seenAt: app.clock.now() })
        .where(
          and(
            eq(notifications.userId, viewer.id),
            eq(notifications.dedupeKey, notificationDedupeKey.tag(media.id)),
            sql`${notifications.seenAt} is null`
          )
        );
      await recordAudit(tx, {
        actorUserId: viewer.id,
        action: AuditAction.MediaTagApproved,
        entityType: "media",
        entityId: media.id,
        metadata: { tagId, personId: changed.personId },
        ip
      });
    }
    const [row] = await selectTags(tx, eq(mediaTags.id, tagId));
    if (row === undefined) throw tagNotFound();
    return { row, media };
  });
  const [tag] = await toMediaTags(app, [outcome.row], viewer, outcome.media.uploadedByUserId);
  if (tag === undefined) throw new Error("social: tag mapping failed");
  return tag;
}

/** Who removed a tag (audit metadata). */
type UntagBy = "self" | "tagger" | "uploader" | "admin";

/**
 * Remove a tag, or decline a pending one (the tagged user). Allowed for the
 * tagger, the photo's uploader, the tagged person's linked user and admins,
 * and only for a tag the caller can see; everyone else: 404.
 */
export async function removeTag(
  app: FastifyInstance,
  mediaId: string,
  tagId: string,
  viewer: Viewer,
  ip: string
): Promise<void> {
  const removed = await app.db.transaction(async (tx) => {
    const media = await lockViewableMedia(tx, mediaId, viewer, "update");
    const admin = viewer.role === "admin";
    const personUserIdSql = sql<string | null>`(select ${people.userId} from ${people} where ${people.id} = ${mediaTags.personId})`;
    const isUploader = media.uploadedByUserId !== null && media.uploadedByUserId === viewer.id;
    // [SEC] Visible to the caller (tagVisibleSql over a correlated person lookup) and theirs to remove.
    // The uploader removes approved tags only: a pending one is invisible to them.
    const uploaderRight = isUploader ? sql` or ${mediaTags.status} = 'approved'` : sql``;
    const rights = admin
      ? sql`true`
      : sql`(${mediaTags.taggedByUserId} = ${viewer.id} or ${personUserIdSql} = ${viewer.id}${uploaderRight})`;
    const [row] = await tx
      .delete(mediaTags)
      .where(and(eq(mediaTags.id, tagId), eq(mediaTags.mediaId, media.id), rights))
      .returning({
        personId: mediaTags.personId,
        status: mediaTags.status,
        taggedByUserId: mediaTags.taggedByUserId,
        personUserId: personUserIdSql
      });
    if (row === undefined) throw tagNotFound();
    const by: UntagBy =
      row.personUserId === viewer.id ? "self" : row.taggedByUserId === viewer.id ? "tagger" : isUploader ? "uploader" : "admin";
    await recordAudit(tx, {
      actorUserId: viewer.id,
      action: AuditAction.MediaUntagged,
      entityType: "media",
      entityId: media.id,
      metadata: { tagId, personId: row.personId, status: row.status, by },
      ip
    });
    return row;
  });
  queueTagRequestRetraction(app, mediaId, removed.personUserId);
}

function tagNotFound(): AppError {
  return new AppError("NOT_FOUND", TAG_NOT_FOUND_MESSAGE);
}

/**
 * People the caller may tag (`GET /api/media/:id/tag-candidates`): any
 * person whose name or nickname matches, the caller's own person first. The
 * photo follows the unlisted/disabled rules (name only for hidden members).
 */
export async function searchTagCandidates(
  app: FastifyInstance,
  q: string,
  limit: number,
  viewer: Viewer
): Promise<TagCandidate[]> {
  const pattern = `%${escapeLike(q)}%`;
  const rows = await selectPersonViews(app.db, or(ilike(people.fullName, pattern), ilike(people.nickname, pattern)), {
    orderBy: [sql`(${people.userId} is not distinct from ${viewer.id}) desc`, asc(people.fullName), asc(people.id)],
    limit
  });
  const avatars = await presignPersonAvatars(
    { storage: app.storage, log: app.log },
    rows,
    familyViewer(viewer),
    AvatarSize.Small
  );
  return rows.map((row) => ({
    id: row.id,
    name: row.fullName,
    nickname: row.nickname,
    avatarUrl: avatars.get(row.id) ?? null,
    isMe: row.userId !== null && row.userId === viewer.id
  }));
}

/** Result of {@link moveMediaTagsTx}. */
export interface MoveMediaTagsResult {
  /** Tags re-pointed to the kept person. */
  moved: number;
  /** Tags deleted because the photo already had (or got) a tag of the kept person. */
  dropped: number;
}

/**
 * Person merge integration (WP-6.0 interface; **WP-6.4's `mergePeopleTx`
 * calls it** inside the merge transaction, after locking both people and
 * before deleting the duplicate).
 *
 * - Every tag of `fromPersonId` moves to `toPersonId`.
 * - Where the photo already has a tag of `toPersonId`, one survives: an
 *   approved one wins over a pending one; on a tie the kept person's tag.
 * - A moved tag becomes `pending` again when the kept person is linked to an
 *   account that is not the duplicate's (as read now) and that account is not
 *   the tagger: that user never consented. **Call it before moving the
 *   duplicate's account link to keep**; called after, the duplicate reads as
 *   unlinked and its approved tags fail closed to `pending` (the user
 *   approves them again).
 * - No notification is written for re-pended tags (the tagged user sees them
 *   in the photo detail and in "Fotos").
 *
 * @param tx - The merge transaction.
 * @param fromPersonId - The duplicate (deleted afterwards).
 * @param toPersonId - The person that stays.
 */
export async function moveMediaTagsTx(tx: Transaction, fromPersonId: string, toPersonId: string): Promise<MoveMediaTagsResult> {
  if (fromPersonId === toPersonId) return { moved: 0, dropped: 0 };
  const links = await tx
    .select({ id: people.id, userId: people.userId })
    .from(people)
    .where(inArray(people.id, [fromPersonId, toPersonId]));
  const fromUserId = links.find((row) => row.id === fromPersonId)?.userId ?? null;
  const toUserId = links.find((row) => row.id === toPersonId)?.userId ?? null;

  // Lock both people's tags (stable order) so the dedupe below sees a fixed set.
  await tx
    .select({ id: mediaTags.id })
    .from(mediaTags)
    .where(inArray(mediaTags.personId, [fromPersonId, toPersonId]))
    .orderBy(asc(mediaTags.id))
    .for("update");

  // The status a duplicate's tag gets on keep.
  const movedStatusSql =
    toUserId === null || toUserId === fromUserId
      ? sql`${mediaTags.status}`
      : sql`(case when ${mediaTags.taggedByUserId} = ${toUserId} then ${mediaTags.status} else 'pending' end)`;

  const fromTags = await tx
    .select({ id: mediaTags.id, mediaId: mediaTags.mediaId, newStatus: sql<MediaTagStatus>`${movedStatusSql}` })
    .from(mediaTags)
    .where(eq(mediaTags.personId, fromPersonId));
  if (fromTags.length === 0) return { moved: 0, dropped: 0 };
  const keepTags = await tx
    .select({ id: mediaTags.id, mediaId: mediaTags.mediaId, status: mediaTags.status })
    .from(mediaTags)
    .where(and(eq(mediaTags.personId, toPersonId), inArray(mediaTags.mediaId, fromTags.map((tag) => tag.mediaId))));
  const keepByMedia = new Map(keepTags.map((tag) => [tag.mediaId, tag]));

  const dropIds: string[] = [];
  const moveIds: string[] = [];
  for (const tag of fromTags) {
    const keep = keepByMedia.get(tag.mediaId);
    if (keep === undefined) {
      moveIds.push(tag.id);
    } else if (keep.status !== MediaTagStatus.Approved && tag.newStatus === MediaTagStatus.Approved) {
      dropIds.push(keep.id);
      moveIds.push(tag.id);
    } else {
      dropIds.push(tag.id);
    }
  }
  if (dropIds.length > 0) await tx.delete(mediaTags).where(inArray(mediaTags.id, dropIds));
  if (moveIds.length > 0) {
    await tx
      .update(mediaTags)
      .set({
        personId: toPersonId,
        status: sql`${movedStatusSql}`,
        approvedAt: sql`case when ${movedStatusSql} = 'approved' then coalesce(${mediaTags.approvedAt}, now()) else null end`
      })
      .where(inArray(mediaTags.id, moveIds));
  }
  return { moved: moveIds.length, dropped: dropIds.length };
}
