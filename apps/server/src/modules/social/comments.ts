/**
 * Photo comments (WP-6.2, ADR 0001 §8 "Comments").
 *
 * - Any viewer of the photo reads (oldest first) and writes (idempotent per
 *   author and `clientCommentId`); a new comment notifies the uploader
 *   (`photo_commented`).
 * - **Author-only delete** on the member route (anyone else, admins
 *   included: 404 `COMMENT_NOT_FOUND`); admins moderate through the admin
 *   route, audited. Every delete **scrubs the stored body** to `''` in the
 *   same statement: the tombstone `{ deleted: true, body: "", author: null }`.
 * - Reports mirror media reports (one per member per comment; your own: 403).
 *
 * A comment addressed by its own id is resolved through its photo under the
 * caller's scope (`viewableSql`) in the same statement [SEC].
 */
import {
  type AdminReportedComment,
  AuditAction,
  type MediaComment,
  type MediaReport,
  NotificationKind,
  type Page,
  type ReportMediaCommentInput
} from "@cuencada/types";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { commentReports, mediaComments, mediaItems, profiles, users } from "../../db/schema/index.js";
import { type DbOrTx, recordAudit } from "../../lib/audit.js";
import { AppError } from "../../lib/errors.js";
import { decodeCursor, encodeCursor } from "../media/cursor.js";
import { viewableSql, type Viewer } from "../media/service.js";
import { pushNotifications, recordNotification } from "../notifications/notify.js";
import { commentNotFound, lockViewableMedia, micros, presignMemberAvatars, visibleAvatarKey } from "./shared.js";

/** Reports listed per comment in the admin queue. */
const ADMIN_REPORTS_PER_COMMENT = 20;

interface CommentRow {
  id: string;
  mediaId: string;
  authorUserId: string | null;
  authorName: string | null;
  avatarKey: string | null;
  listedInDirectory: boolean | null;
  userStatus: string | null;
  body: string;
  clientCommentId: string | null;
  deletedAt: Date | null;
  createdAt: Date;
  cursorMicros: string;
}

function selectComments(db: DbOrTx) {
  return db
    .select({
      id: mediaComments.id,
      mediaId: mediaComments.mediaId,
      authorUserId: mediaComments.authorUserId,
      authorName: users.displayName,
      avatarKey: profiles.avatarKey,
      listedInDirectory: profiles.listedInDirectory,
      userStatus: users.status,
      body: mediaComments.body,
      clientCommentId: mediaComments.clientCommentId,
      deletedAt: mediaComments.deletedAt,
      createdAt: mediaComments.createdAt,
      cursorMicros: micros(mediaComments.createdAt)
    })
    .from(mediaComments)
    .leftJoin(users, eq(users.id, mediaComments.authorUserId))
    .leftJoin(profiles, eq(profiles.userId, mediaComments.authorUserId));
}

/** Map comments for `viewer`; deleted ones become tombstones (no body, no author). */
async function toMediaComments(app: FastifyInstance, rows: readonly CommentRow[], viewer: Viewer): Promise<MediaComment[]> {
  const keys = rows.map((row) =>
    row.deletedAt !== null
      ? null
      : visibleAvatarKey({ userId: row.authorUserId, avatarKey: row.avatarKey, listedInDirectory: row.listedInDirectory, userStatus: row.userStatus }, viewer)
  );
  const avatars = await presignMemberAvatars({ storage: app.storage, log: app.log }, keys);
  return rows.map((row, index): MediaComment => {
    const base = { id: row.id, mediaId: row.mediaId, createdAt: row.createdAt.toISOString() };
    if (row.deletedAt !== null) {
      return { ...base, author: null, body: "", deleted: true, canDelete: false, canModerate: false };
    }
    const key = keys[index] ?? null;
    const isMe = row.authorUserId !== null && row.authorUserId === viewer.id;
    return {
      ...base,
      author:
        row.authorUserId === null || row.authorName === null
          ? null
          : { name: row.authorName, avatarUrl: key === null ? null : (avatars.get(key) ?? null), isMe },
      body: row.body,
      deleted: false,
      canDelete: isMe,
      canModerate: viewer.role === "admin"
    };
  });
}

/**
 * A page of a photo's comments, oldest first (keyset on `created_at, id`).
 * Callers checked the photo first.
 */
export async function listComments(
  app: FastifyInstance,
  mediaId: string,
  viewer: Viewer,
  options: { limit: number; cursor?: string | undefined }
): Promise<Page<MediaComment>> {
  const cursor = options.cursor === undefined ? undefined : decodeCursor(options.cursor);
  const rows = await selectComments(app.db)
    .where(
      and(
        eq(mediaComments.mediaId, mediaId),
        cursor === undefined
          ? undefined
          : sql`(${mediaComments.createdAt}, ${mediaComments.id}) > (to_timestamp(0) + ${cursor.micros}::bigint * interval '1 microsecond', ${cursor.id}::uuid)`
      )
    )
    .orderBy(asc(mediaComments.createdAt), asc(mediaComments.id))
    .limit(options.limit + 1);
  const page = rows.slice(0, options.limit);
  const last = page.at(-1);
  return {
    items: await toMediaComments(app, page, viewer),
    nextCursor: rows.length > options.limit && last !== undefined ? encodeCursor({ micros: last.cursorMicros, id: last.id }) : null
  };
}

/** Result of {@link createComment}. */
export interface CreateCommentResult {
  comment: MediaComment;
  /** `false` on a `clientCommentId` replay (200). */
  created: boolean;
}

/**
 * Add a comment (photo share-locked under the viewer's scope; 404 when not
 * visible). A replay of the same author's `clientCommentId` on the same photo
 * answers the stored comment; on another photo it is 409.
 */
export async function createComment(
  app: FastifyInstance,
  mediaId: string,
  input: { body: string; clientCommentId?: string },
  viewer: Viewer
): Promise<CreateCommentResult> {
  const outcome = await app.db.transaction(async (tx) => {
    const media = await lockViewableMedia(tx, mediaId, viewer, "share");
    const [inserted] = await tx
      .insert(mediaComments)
      .values({ mediaId: media.id, authorUserId: viewer.id, body: input.body, clientCommentId: input.clientCommentId ?? null })
      .onConflictDoNothing({
        target: [mediaComments.authorUserId, mediaComments.clientCommentId],
        where: sql`client_comment_id is not null`
      })
      .returning({ id: mediaComments.id });
    const ids: string[] = [];
    if (inserted !== undefined && media.uploadedByUserId !== null) {
      const id = await recordNotification(tx, {
        recipientUserId: media.uploadedByUserId,
        actorUserId: viewer.id,
        kind: NotificationKind.PhotoCommented,
        target: { mediaId: media.id }
      });
      if (id !== null) ids.push(id);
    }
    const where =
      inserted !== undefined
        ? eq(mediaComments.id, inserted.id)
        : and(eq(mediaComments.authorUserId, viewer.id), eq(mediaComments.clientCommentId, input.clientCommentId ?? ""));
    const [row] = await selectComments(tx).where(where).limit(1);
    if (row === undefined) throw new Error("social: comment vanished");
    if (row.mediaId !== media.id) {
      throw new AppError("CONFLICT", "Ese identificador ya se usó en otro comentario.", {
        details: [{ path: "clientCommentId", message: "Ya usado." }]
      });
    }
    return { row, created: inserted !== undefined, ids };
  });
  if (outcome.ids.length > 0) await pushNotifications(app, outcome.ids);
  const [comment] = await toMediaComments(app, [outcome.row], viewer);
  if (comment === undefined) throw new Error("social: comment mapping failed");
  return { comment, created: outcome.created };
}

/**
 * Lock a comment through its photo under the viewer's scope (one statement).
 *
 * @returns The comment, or `null` (404).
 */
async function lockViewableComment(
  tx: DbOrTx,
  commentId: string,
  viewer: Viewer
): Promise<{ id: string; mediaId: string; authorUserId: string | null; deletedAt: Date | null } | null> {
  const [row] = await tx
    .select({
      id: mediaComments.id,
      mediaId: mediaComments.mediaId,
      authorUserId: mediaComments.authorUserId,
      deletedAt: mediaComments.deletedAt
    })
    .from(mediaComments)
    .innerJoin(mediaItems, eq(mediaItems.id, mediaComments.mediaId))
    .where(and(eq(mediaComments.id, commentId), viewableSql(viewer)))
    .for("update", { of: mediaComments })
    .limit(1);
  return row ?? null;
}

/** Scrub a comment to its tombstone (body `''`). */
async function scrubComment(tx: DbOrTx, commentId: string, deletedBy: string, now: Date): Promise<boolean> {
  const updated = await tx
    .update(mediaComments)
    .set({ body: "", deletedAt: now, deletedByUserId: deletedBy })
    .where(and(eq(mediaComments.id, commentId), isNull(mediaComments.deletedAt)))
    .returning({ id: mediaComments.id });
  return updated.length > 0;
}

/**
 * Member delete: the author only (404 `COMMENT_NOT_FOUND` for anyone else,
 * admins included). Idempotent on an already deleted own comment.
 */
export async function deleteOwnComment(app: FastifyInstance, commentId: string, viewer: Viewer): Promise<void> {
  await app.db.transaction(async (tx) => {
    const comment = await lockViewableComment(tx, commentId, viewer);
    if (comment === null || comment.authorUserId !== viewer.id) throw commentNotFound();
    await scrubComment(tx, comment.id, viewer.id, app.clock.now());
  });
}

/** Admin moderation delete (audited, ids only). Idempotent. */
export async function moderateDeleteComment(app: FastifyInstance, commentId: string, admin: Viewer, ip: string): Promise<void> {
  await app.db.transaction(async (tx) => {
    const comment = await lockViewableComment(tx, commentId, admin);
    if (comment === null) throw commentNotFound();
    const changed = await scrubComment(tx, comment.id, admin.id, app.clock.now());
    if (!changed) return;
    await recordAudit(tx, {
      actorUserId: admin.id,
      action: AuditAction.MediaCommentDeleted,
      entityType: "media_comment",
      entityId: comment.id,
      metadata: { mediaId: comment.mediaId, authorUserId: comment.authorUserId },
      ip
    });
  });
}

/**
 * Report a live comment on a photo the caller can see. Own comment: 403;
 * a repeat: 409. Reasons and details are never logged.
 */
export async function reportComment(
  app: FastifyInstance,
  commentId: string,
  input: ReportMediaCommentInput,
  viewer: Viewer,
  ip: string
): Promise<void> {
  await app.db.transaction(async (tx) => {
    const comment = await lockViewableComment(tx, commentId, viewer);
    if (comment === null || comment.deletedAt !== null) throw commentNotFound();
    if (comment.authorUserId === viewer.id) throw new AppError("FORBIDDEN", "No puedes reportar tu propio comentario.");
    const [report] = await tx
      .insert(commentReports)
      .values({ commentId: comment.id, reporterUserId: viewer.id, reason: input.reason, details: input.details })
      .onConflictDoNothing({ target: [commentReports.commentId, commentReports.reporterUserId] })
      .returning({ id: commentReports.id });
    if (report === undefined) throw new AppError("CONFLICT", "Ya habías reportado este comentario.");
    await recordAudit(tx, {
      actorUserId: viewer.id,
      action: AuditAction.MediaCommentReported,
      entityType: "media_comment",
      entityId: comment.id,
      metadata: { mediaId: comment.mediaId, reportId: report.id, reason: input.reason },
      ip
    });
  });
}

/** Live comment count of one photo. */
export async function countComments(db: DbOrTx, mediaId: string): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(mediaComments)
    .where(and(eq(mediaComments.mediaId, mediaId), isNull(mediaComments.deletedAt)));
  return row?.total ?? 0;
}

/**
 * Admin queue: comments with reports, newest report first (keyset on the
 * latest report time and comment id). Deleted comments only with
 * `includeDeleted` (their body is already `''`).
 */
export async function listReportedComments(
  db: DbOrTx,
  options: { limit: number; cursor?: string | undefined; includeDeleted: boolean }
): Promise<Page<AdminReportedComment>> {
  const cursor = options.cursor === undefined ? undefined : decodeCursor(options.cursor);
  const latest = sql<Date>`max(${commentReports.createdAt})`;
  const rows = await db
    .select({
      id: mediaComments.id,
      mediaId: mediaComments.mediaId,
      body: mediaComments.body,
      authorName: users.displayName,
      authorUserId: mediaComments.authorUserId,
      createdAt: mediaComments.createdAt,
      deletedAt: mediaComments.deletedAt,
      reportCount: sql<number>`count(${commentReports.id})::int`,
      latestMicros: sql<string>`(extract(epoch from ${latest}) * 1000000)::bigint::text`
    })
    .from(mediaComments)
    .innerJoin(commentReports, eq(commentReports.commentId, mediaComments.id))
    .leftJoin(users, eq(users.id, mediaComments.authorUserId))
    .where(options.includeDeleted ? undefined : isNull(mediaComments.deletedAt))
    .groupBy(mediaComments.id, users.displayName)
    .having(
      cursor === undefined
        ? undefined
        : sql`(${latest}, ${mediaComments.id}) < (to_timestamp(0) + ${cursor.micros}::bigint * interval '1 microsecond', ${cursor.id}::uuid)`
    )
    .orderBy(desc(latest), desc(mediaComments.id))
    .limit(options.limit + 1);
  const page = rows.slice(0, options.limit);
  const reports = await reportsByComment(
    db,
    page.map((row) => row.id)
  );
  const last = page.at(-1);
  return {
    items: page.map((row) => ({
      id: row.id,
      mediaId: row.mediaId,
      body: row.deletedAt === null ? row.body : "",
      authorName: row.authorName,
      authorUserId: row.authorUserId,
      createdAt: row.createdAt.toISOString(),
      deletedAt: row.deletedAt?.toISOString() ?? null,
      reportCount: row.reportCount,
      reports: reports.get(row.id) ?? []
    })),
    nextCursor: rows.length > options.limit && last !== undefined ? encodeCursor({ micros: last.latestMicros, id: last.id }) : null
  };
}

/** The newest {@link ADMIN_REPORTS_PER_COMMENT} reports of each comment. */
async function reportsByComment(db: DbOrTx, commentIds: readonly string[]): Promise<Map<string, MediaReport[]>> {
  if (commentIds.length === 0) return new Map();
  const rows = await db
    .select({
      id: commentReports.id,
      commentId: commentReports.commentId,
      reason: commentReports.reason,
      details: commentReports.details,
      reporterName: users.displayName,
      createdAt: commentReports.createdAt
    })
    .from(commentReports)
    .leftJoin(users, eq(users.id, commentReports.reporterUserId))
    .where(inArray(commentReports.commentId, [...commentIds]))
    .orderBy(desc(commentReports.createdAt), desc(commentReports.id));
  const byComment = new Map<string, MediaReport[]>();
  for (const row of rows) {
    const list = byComment.get(row.commentId) ?? [];
    if (list.length >= ADMIN_REPORTS_PER_COMMENT) continue;
    list.push({ id: row.id, reason: row.reason, details: row.details, reporterName: row.reporterName, createdAt: row.createdAt.toISOString() });
    byComment.set(row.commentId, list);
  }
  return byComment;
}
