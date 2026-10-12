/**
 * Hearts on photos (WP-6.2, ADR 0001 §8 "Hearts"). `PUT|DELETE` are
 * idempotent and answer the new state; a new heart notifies the uploader
 * (`photo_liked`, coalesced per photo by the notifications module); an
 * unlike leaves the notification. Likers are listed by name; avatars only
 * for listed, active members; never account ids.
 */
import { type MediaLikeState, type MediaLiker, NotificationKind, type Page } from "@cuencada/types";
import { and, desc, eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { mediaLikes, profiles, users } from "../../db/schema/index.js";
import type { DbOrTx } from "../../lib/audit.js";
import { decodeCursor, encodeCursor } from "../media/cursor.js";
import type { Viewer } from "../media/service.js";
import { pushNotifications, recordNotification } from "../notifications/notify.js";
import { lockViewableMedia, micros, presignMemberAvatars, visibleAvatarKey } from "./shared.js";

/** The like state of one photo for `viewerId`. */
export async function likeState(db: DbOrTx, mediaId: string, viewerId: string): Promise<MediaLikeState> {
  const [row] = await db
    .select({
      likeCount: sql<number>`count(*)::int`,
      likedByMe: sql<boolean>`coalesce(bool_or(${mediaLikes.userId} = ${viewerId}), false)`
    })
    .from(mediaLikes)
    .where(eq(mediaLikes.mediaId, mediaId));
  return { likeCount: row?.likeCount ?? 0, likedByMe: row?.likedByMe ?? false };
}

/**
 * Give (`liked = true`) or take back a heart. The photo is share-locked under
 * the viewer's scope first (404 when not visible).
 */
export async function setLike(app: FastifyInstance, mediaId: string, viewer: Viewer, liked: boolean): Promise<MediaLikeState> {
  const { state, notificationIds } = await app.db.transaction(async (tx) => {
    const media = await lockViewableMedia(tx, mediaId, viewer, "share");
    const ids: string[] = [];
    if (liked) {
      const inserted = await tx
        .insert(mediaLikes)
        .values({ mediaId: media.id, userId: viewer.id })
        .onConflictDoNothing()
        .returning({ mediaId: mediaLikes.mediaId });
      if (inserted.length > 0 && media.uploadedByUserId !== null) {
        const id = await recordNotification(tx, {
          recipientUserId: media.uploadedByUserId,
          actorUserId: viewer.id,
          kind: NotificationKind.PhotoLiked,
          target: { mediaId: media.id }
        });
        if (id !== null) ids.push(id);
      }
    } else {
      await tx.delete(mediaLikes).where(and(eq(mediaLikes.mediaId, media.id), eq(mediaLikes.userId, viewer.id)));
    }
    return { state: await likeState(tx, media.id, viewer.id), notificationIds: ids };
  });
  if (notificationIds.length > 0) await pushNotifications(app, notificationIds);
  return state;
}

/**
 * Who gave a heart, newest first (keyset on `created_at desc, user_id desc`).
 * Callers checked the photo first.
 */
export async function listLikers(
  app: FastifyInstance,
  mediaId: string,
  viewer: Viewer,
  options: { limit: number; cursor?: string | undefined }
): Promise<Page<MediaLiker>> {
  const cursor = options.cursor === undefined ? undefined : decodeCursor(options.cursor);
  const rows = await app.db
    .select({
      userId: mediaLikes.userId,
      name: users.displayName,
      avatarKey: profiles.avatarKey,
      listedInDirectory: profiles.listedInDirectory,
      userStatus: users.status,
      cursorMicros: micros(mediaLikes.createdAt)
    })
    .from(mediaLikes)
    .innerJoin(users, eq(users.id, mediaLikes.userId))
    .leftJoin(profiles, eq(profiles.userId, mediaLikes.userId))
    .where(
      and(
        eq(mediaLikes.mediaId, mediaId),
        cursor === undefined
          ? undefined
          : sql`(${mediaLikes.createdAt}, ${mediaLikes.userId}) < (to_timestamp(0) + ${cursor.micros}::bigint * interval '1 microsecond', ${cursor.id}::uuid)`
      )
    )
    .orderBy(desc(mediaLikes.createdAt), desc(mediaLikes.userId))
    .limit(options.limit + 1);
  const page = rows.slice(0, options.limit);
  const keys = page.map((row) => visibleAvatarKey(row, viewer));
  const avatars = await presignMemberAvatars({ storage: app.storage, log: app.log }, keys);
  const last = page.at(-1);
  return {
    items: page.map((row, index) => {
      const key = keys[index] ?? null;
      return { name: row.name, avatarUrl: key === null ? null : (avatars.get(key) ?? null), isMe: row.userId === viewer.id };
    }),
    nextCursor:
      rows.length > options.limit && last !== undefined ? encodeCursor({ micros: last.cursorMicros, id: last.userId }) : null
  };
}
