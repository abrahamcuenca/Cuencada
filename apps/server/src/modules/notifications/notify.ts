/**
 * Notification writers (WP-6.0 stub, WP-6.1 implementation). The signatures
 * are fixed so WP-6.2 (tags, comments, likes) and WP-6.4 (proposal
 * resolution) can call them. Rules: ADR 0001 §8.
 *
 * - {@link recordNotification} runs **inside the caller's transaction**, so a
 *   rolled-back action leaves no notification. It upserts on
 *   `(user_id, dedupe_key)` (`notificationDedupeKey`), never writes a
 *   self-notification (returns `null`), and trims the recipient to
 *   `NOTIFICATIONS_PER_USER_MAX` rows (seen ones first, then the oldest).
 * - {@link retractNotification} deletes one row (a removed or declined tag,
 *   a member who left the event).
 * - {@link markNotificationSeen} marks one row seen (an approved tag).
 * - {@link pushNotifications} runs **after the commit**: it rebuilds each
 *   notification through the feed's read model (visibility re-checked for the
 *   recipient) and sends the `notification` frame to that recipient's own
 *   sockets only. When the row is gone, invisible, or the read fails, it
 *   sends nothing; failures are logged with ids only and never fail the
 *   request.
 *
 * Coalescing (WP-6.0 decision 3): a repeat moves `created_at` (the feed
 * order) to now, sets the latest actor and clears `seen_at`. Like `count` is
 * recomputed from `media_likes` (likes from others than the recipient), so
 * like/unlike/like never inflates it; comment `count` grows while unread and
 * restarts at 1 once seen; every other kind stays at 1.
 */
import {
  NOTIFICATIONS_PER_USER_MAX,
  NotificationKind,
  notificationDedupeKey,
  type WsServerNotification,
  wsServerNotificationSchema
} from "@cuencada/types";
import { and, eq, inArray, isNull, type SQL, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { mediaLikes, notifications, users } from "../../db/schema/index.js";
import type { Transaction } from "../../lib/audit.js";
import { chatHubOf } from "../chat/index.js";
import { countUnread, loadNotifications, type NotificationViewer } from "./repository.js";

/** The entity a notification points at: exactly the one its kind needs (DB CHECK `notifications_target_check`). */
export type NotificationTargetInput = { mediaId: string } | { eventId: string } | { proposalId: string };

/** What happened, to whom and by whom. */
export interface RecordNotificationInput {
  recipientUserId: string;
  /** The member who caused it; `null` for system actions. Equal to the recipient → nothing is written. */
  actorUserId: string | null;
  kind: NotificationKind;
  target: NotificationTargetInput;
}

/** The FK columns and dedupe key of one notification. */
interface ResolvedTarget {
  mediaId: string | null;
  eventId: string | null;
  proposalId: string | null;
  dedupeKey: string;
}

/**
 * The columns for `kind` + `target`.
 *
 * @throws Error when the target does not match the kind (a programming error; the DB CHECK would refuse it too).
 */
function resolveTarget(kind: NotificationKind, target: NotificationTargetInput): ResolvedTarget {
  const none = { mediaId: null, eventId: null, proposalId: null };
  switch (kind) {
    case NotificationKind.PhotoTagRequest:
    case NotificationKind.PhotoCommented:
    case NotificationKind.PhotoLiked: {
      if (!("mediaId" in target)) break;
      const key =
        kind === NotificationKind.PhotoTagRequest
          ? notificationDedupeKey.tag(target.mediaId)
          : kind === NotificationKind.PhotoCommented
            ? notificationDedupeKey.comment(target.mediaId)
            : notificationDedupeKey.like(target.mediaId);
      return { ...none, mediaId: target.mediaId, dedupeKey: key };
    }
    case NotificationKind.EventAdded:
      if (!("eventId" in target)) break;
      return { ...none, eventId: target.eventId, dedupeKey: notificationDedupeKey.event(target.eventId) };
    case NotificationKind.TreeProposalResolved:
      if (!("proposalId" in target)) break;
      return { ...none, proposalId: target.proposalId, dedupeKey: notificationDedupeKey.proposal(target.proposalId) };
  }
  throw new Error(`notification target does not match kind ${kind}`);
}

/** SQL: likes on the photo from anyone but the recipient (at least 1: the like being recorded). */
function likeCountSql(mediaId: string, recipientUserId: string): SQL<number> {
  return sql<number>`greatest(1, (select count(*)::int from ${mediaLikes}
    where ${mediaLikes.mediaId} = ${mediaId}::uuid and ${mediaLikes.userId} <> ${recipientUserId}::uuid))`;
}

/** The `count` of a re-fired row (see the module doc). */
function coalescedCountSql(kind: NotificationKind, mediaId: string | null, recipientUserId: string): SQL<number> {
  if (kind === NotificationKind.PhotoLiked && mediaId !== null) return likeCountSql(mediaId, recipientUserId);
  if (kind === NotificationKind.PhotoCommented) {
    return sql<number>`case when ${notifications.seenAt} is null then ${notifications.count} + 1 else 1 end`;
  }
  return sql<number>`1`;
}

/**
 * Deletes the recipient's rows beyond {@link NOTIFICATIONS_PER_USER_MAX},
 * keeping unread ones first, then the newest (seen and oldest go first).
 */
async function trimRecipient(tx: Transaction, recipientUserId: string): Promise<void> {
  await tx.execute(sql`delete from ${notifications} where ${notifications.id} in (
    select n.id from ${notifications} n
    where n.user_id = ${recipientUserId}::uuid
    order by (n.seen_at is null) desc, n.created_at desc, n.id desc
    offset ${NOTIFICATIONS_PER_USER_MAX}
  )`);
}

/**
 * Writes (or coalesces into) the recipient's notification inside `tx`.
 *
 * @returns The notification id to pass to {@link pushNotifications} after the commit, or `null` when nothing was written.
 */
export async function recordNotification(tx: Transaction, input: RecordNotificationInput): Promise<string | null> {
  const { recipientUserId, actorUserId, kind } = input;
  if (actorUserId !== null && actorUserId === recipientUserId) return null;
  const target = resolveTarget(kind, input.target);
  const firstCount =
    kind === NotificationKind.PhotoLiked && target.mediaId !== null ? likeCountSql(target.mediaId, recipientUserId) : sql<number>`1`;
  const [row] = await tx
    .insert(notifications)
    .values({
      userId: recipientUserId,
      kind,
      actorUserId,
      mediaId: target.mediaId,
      eventId: target.eventId,
      proposalId: target.proposalId,
      dedupeKey: target.dedupeKey,
      count: firstCount
    })
    .onConflictDoUpdate({
      target: [notifications.userId, notifications.dedupeKey],
      targetWhere: sql`dedupe_key is not null`,
      set: {
        count: coalescedCountSql(kind, target.mediaId, recipientUserId),
        actorUserId,
        createdAt: sql`now()`,
        updatedAt: sql`now()`,
        seenAt: null
      }
    })
    .returning({ id: notifications.id });
  if (row === undefined) throw new Error("notification upsert returned no row");
  await trimRecipient(tx, recipientUserId);
  return row.id;
}

/** Deletes the recipient's notification with `dedupeKey` inside `tx` (no-op when absent). */
export async function retractNotification(tx: Transaction, recipientUserId: string, dedupeKey: string): Promise<void> {
  await tx.delete(notifications).where(and(eq(notifications.userId, recipientUserId), eq(notifications.dedupeKey, dedupeKey)));
}

/**
 * Marks the recipient's notification with `dedupeKey` as seen inside `tx`
 * (e.g. an approved tag request; no-op when absent or already seen).
 */
export async function markNotificationSeen(tx: Transaction, recipientUserId: string, dedupeKey: string): Promise<void> {
  await tx
    .update(notifications)
    .set({ seenAt: sql`now()` })
    .where(and(eq(notifications.userId, recipientUserId), eq(notifications.dedupeKey, dedupeKey), isNull(notifications.seenAt)));
}

/** The error's class name only (never its message: it could carry data). */
function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "unknown";
}

/**
 * Builds the frame for one recipient through the feed's read model, or
 * `null` when there is nothing visible to send.
 */
async function framesFor(app: FastifyInstance, viewer: NotificationViewer, ids: readonly string[]): Promise<WsServerNotification[]> {
  const items = await loadNotifications(app, viewer, { ids });
  if (items.length === 0) return [];
  const unreadCount = await countUnread(app.db, viewer);
  return items.flatMap((notification) => {
    const parsed = wsServerNotificationSchema.safeParse({ type: "notification", notification, unreadCount });
    if (!parsed.success) {
      app.log.error({ notificationId: notification.id }, "notification frame failed validation; not sent");
      return [];
    }
    return [parsed.data];
  });
}

/** After the commit: pushes each still-visible notification to its recipient's sockets (best effort). */
export async function pushNotifications(app: FastifyInstance, ids: readonly string[]): Promise<void> {
  const hub = chatHubOf(app);
  const unique = [...new Set(ids)];
  if (hub === null || unique.length === 0) return;
  let recipients: Array<{ id: string; userId: string; role: NotificationViewer["role"] }>;
  try {
    recipients = await app.db
      .select({ id: notifications.id, userId: notifications.userId, role: users.role })
      .from(notifications)
      .innerJoin(users, eq(users.id, notifications.userId))
      .where(and(inArray(notifications.id, unique), eq(users.status, "active")));
  } catch (error) {
    app.log.warn({ notificationIds: unique, errorName: errorName(error) }, "notification push skipped: read failed");
    return;
  }
  const byUser = new Map<string, { role: NotificationViewer["role"]; ids: string[] }>();
  for (const row of recipients) {
    // Offline recipients: nothing to build.
    if (!hub.isUserConnected(row.userId)) continue;
    const entry = byUser.get(row.userId) ?? { role: row.role, ids: [] };
    entry.ids.push(row.id);
    byUser.set(row.userId, entry);
  }
  for (const [userId, { role, ids: userIds }] of byUser) {
    try {
      const frames = await framesFor(app, { id: userId, role }, userIds);
      for (const frame of frames) hub.sendToUser(userId, frame);
    } catch (error) {
      app.log.warn({ notificationIds: userIds, errorName: errorName(error) }, "notification push skipped: read failed");
    }
  }
}
