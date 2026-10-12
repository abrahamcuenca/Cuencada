/**
 * The notification read model (WP-6.1) [SEC]: one query shape for the feed,
 * the unread count, the push frames and the deprecated event-notice shim.
 *
 * **Visibility at read time (ADR 0001 §8, requirement 7).** A row is
 * returned only while its target is visible to the recipient **now**:
 * photo kinds join `media_items` under `viewableSql(recipient)` (scope +
 * member visibility: a left event, a hidden box, a moderated photo drop it);
 * `event_added` joins `events` under `eventVisibleSql(recipient)`;
 * `tree_proposal_resolved` needs the recipient's own resolved proposal.
 * Everything is scoped to `user_id = recipient` first.
 *
 * **Actors** are resolved from the current account: the name always (while
 * the account exists), the avatar only for members listed in the directory
 * and active (an actor who became unlisted or disabled later shows the name
 * only); never an account id.
 */
import {
  type EventRef,
  MEDIA_NOTIFICATION_KINDS,
  NOTIFICATION_UNREAD_COUNT_MAX,
  type Notification,
  type NotificationActor,
  NotificationKind,
  type NotificationTarget,
  type UserRole
} from "@cuencada/types";
import { and, desc, eq, inArray, isNull, lt, type SQL, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { FastifyBaseLogger } from "fastify";
import {
  cuencadas,
  eventAlbums,
  eventParticipants,
  events,
  mediaItems,
  notifications,
  profiles,
  treeLinkProposals,
  users
} from "../../db/schema/index.js";
import type { DbOrTx } from "../../lib/audit.js";
import type { StorageService } from "../../lib/storage/types.js";
import { eventVisibleSql } from "../events/access.js";
import type { MediaCursor } from "../media/cursor.js";
import { viewableSql } from "../media/service.js";
import { AvatarSize, avatarUrlFor } from "../profile/index.js";

/** The recipient reading their notifications. */
export interface NotificationViewer {
  id: string;
  role: UserRole;
}

/** What the mapper needs from the app. */
export interface NotificationDeps {
  db: DbOrTx;
  storage: Pick<StorageService, "presignGet">;
  log: Pick<FastifyBaseLogger, "warn">;
}

/** How long presigned thumbnails live (as the gallery). */
const THUMB_URL_SECONDS = 3600;

const actor = alias(users, "n_actor");
const actorProfile = alias(profiles, "n_actor_profile");
const albumEvent = alias(events, "n_album_event");
const albumOfMedia = alias(eventAlbums, "n_album");

const mediaKindsSql = sql.raw(MEDIA_NOTIFICATION_KINDS.map((kind) => `'${kind}'`).join(", "));

/**
 * SQL [SEC]: the row's target is visible to `viewer` now (see the module
 * doc). Needs the joins of {@link selectRecords}.
 */
export function notificationVisibleSql(viewer: NotificationViewer): SQL {
  return sql`(
    (${notifications.kind} in (${mediaKindsSql}) and ${mediaItems.id} is not null and ${viewableSql(viewer)})
    or (${notifications.kind} = ${NotificationKind.EventAdded} and ${events.id} is not null and ${eventVisibleSql(viewer)})
    or (${notifications.kind} = ${NotificationKind.TreeProposalResolved}
        and ${treeLinkProposals.proposedByUserId} = ${viewer.id}::uuid
        and ${treeLinkProposals.status} in ('approved', 'rejected'))
  )`;
}

/** SQL: the viewer's role in the event target (`null` when not a participant). */
function viewerRoleSql(viewer: NotificationViewer): SQL<string | null> {
  return sql<string | null>`(select ep_n.role from ${eventParticipants} ep_n
    where ep_n.event_id = ${events.id} and ep_n.user_id = ${viewer.id}::uuid)`;
}

const organizerCountSql = sql<number>`(select count(*)::int from ${eventParticipants} ep_c
  where ep_c.event_id = ${events.id} and ep_c.role = 'organizer')`.mapWith(Number);

const cursorMicrosSql = sql<string>`(extract(epoch from ${notifications.createdAt}) * 1000000)::bigint::text`;

/** The joined row behind one {@link Notification}. */
export type NotificationRecord = Awaited<ReturnType<typeof selectRecords>>[number];

/** Options of {@link selectRecords}: extra conditions, order is always newest first. */
interface SelectOptions {
  where: SQL | undefined;
  limit: number;
}

/** The feed query: the viewer's own visible rows, newest first. */
function selectRecords(db: DbOrTx, viewer: NotificationViewer, options: SelectOptions) {
  return db
    .select({
      id: notifications.id,
      kind: notifications.kind,
      count: notifications.count,
      seenAt: notifications.seenAt,
      createdAt: notifications.createdAt,
      cursorMicros: cursorMicrosSql,
      actorId: actor.id,
      actorName: actor.displayName,
      actorStatus: actor.status,
      actorListed: actorProfile.listedInDirectory,
      actorAvatarKey: actorProfile.avatarKey,
      mediaId: mediaItems.id,
      mediaReady: sql<boolean>`${mediaItems.uploadStatus} = 'ready'`,
      thumbKey: mediaItems.thumbKey,
      editionYear: cuencadas.year,
      memoryAlbumId: mediaItems.memoryAlbumId,
      albumEventId: albumEvent.id,
      albumEventYear: albumEvent.year,
      albumEventSlug: albumEvent.slug,
      albumEventTitle: albumEvent.title,
      eventId: events.id,
      eventYear: events.year,
      eventSlug: events.slug,
      eventTitle: events.title,
      viewerRole: viewerRoleSql(viewer),
      organizerCount: organizerCountSql,
      proposalId: treeLinkProposals.id,
      proposalStatus: treeLinkProposals.status
    })
    .from(notifications)
    .leftJoin(actor, eq(actor.id, notifications.actorUserId))
    .leftJoin(actorProfile, eq(actorProfile.userId, notifications.actorUserId))
    .leftJoin(mediaItems, eq(mediaItems.id, notifications.mediaId))
    .leftJoin(cuencadas, eq(cuencadas.id, mediaItems.cuencadaId))
    .leftJoin(albumOfMedia, eq(albumOfMedia.id, mediaItems.albumId))
    .leftJoin(albumEvent, eq(albumEvent.id, albumOfMedia.eventId))
    .leftJoin(events, eq(events.id, notifications.eventId))
    .leftJoin(treeLinkProposals, eq(treeLinkProposals.id, notifications.proposalId))
    .where(and(eq(notifications.userId, viewer.id), notificationVisibleSql(viewer), options.where))
    .orderBy(desc(notifications.createdAt), desc(notifications.id))
    .limit(options.limit);
}

/** Avatars only for listed, active members (ADR 0001 §8, decision 9). */
async function actorOf(deps: NotificationDeps, record: NotificationRecord): Promise<NotificationActor | null> {
  if (record.actorId === null) return null;
  const showAvatar = record.actorStatus === "active" && record.actorListed === true;
  const avatarUrl = showAvatar ? await avatarUrlFor(deps, record.actorAvatarKey, AvatarSize.Small) : null;
  return { name: record.actorName, avatarUrl };
}

/** Presigned thumbnail, `null` when not ready or when signing fails (never fails the feed). */
async function thumbOf(deps: NotificationDeps, record: NotificationRecord): Promise<string | null> {
  if (!record.mediaReady || record.thumbKey === null) return null;
  try {
    const signed = await deps.storage.presignGet({ key: record.thumbKey, expiresInSeconds: THUMB_URL_SECONDS });
    return signed.url;
  } catch (error) {
    deps.log.warn({ notificationId: record.id, errorName: error instanceof Error ? error.name : "unknown" }, "notification thumb presign failed");
    return null;
  }
}

function eventRef(id: string | null, year: number | null, slug: string | null, title: string | null): EventRef | null {
  return id === null || year === null || slug === null || title === null ? null : { id, year, slug, title };
}

/** The target, or `null` when the joined row is incomplete (dropped, never sent half-built). */
async function targetOf(deps: NotificationDeps, record: NotificationRecord): Promise<NotificationTarget | null> {
  if (record.kind === NotificationKind.EventAdded) {
    const event = eventRef(record.eventId, record.eventYear, record.eventSlug, record.eventTitle);
    if (event === null) return null;
    const participant = record.viewerRole !== null;
    const lastOrganizer = record.viewerRole === "organizer" && record.organizerCount <= 1;
    return { kind: "event", event, canLeave: participant && !lastOrganizer };
  }
  if (record.kind === NotificationKind.TreeProposalResolved) {
    if (record.proposalId === null || (record.proposalStatus !== "approved" && record.proposalStatus !== "rejected")) return null;
    return { kind: "proposal", proposalId: record.proposalId, status: record.proposalStatus };
  }
  if (record.mediaId === null) return null;
  const albumEventRef = eventRef(record.albumEventId, record.albumEventYear, record.albumEventSlug, record.albumEventTitle);
  const place =
    record.editionYear !== null
      ? ({ kind: "edition", year: record.editionYear } as const)
      : albumEventRef !== null
        ? ({ kind: "album", event: albumEventRef } as const)
        : record.memoryAlbumId !== null
          ? ({ kind: "memory", memoryAlbumId: record.memoryAlbumId } as const)
          : null;
  if (place === null) return null;
  return { kind: "media", mediaId: record.mediaId, thumbUrl: await thumbOf(deps, record), place };
}

/** Maps records to the contract, dropping any incomplete one. */
export async function toNotifications(deps: NotificationDeps, records: readonly NotificationRecord[]): Promise<Notification[]> {
  const mapped = await Promise.all(
    records.map(async (record): Promise<Notification | null> => {
      const [target, actorValue] = await Promise.all([targetOf(deps, record), actorOf(deps, record)]);
      if (target === null) return null;
      return {
        id: record.id,
        kind: record.kind,
        actor: actorValue,
        target,
        count: record.count,
        seenAt: record.seenAt === null ? null : record.seenAt.toISOString(),
        createdAt: record.createdAt.toISOString()
      };
    })
  );
  return mapped.filter((item): item is Notification => item !== null);
}

/** Options of {@link listNotificationRecords}. */
export interface ListOptions {
  cursor: MediaCursor | null;
  limit: number;
  unreadOnly: boolean;
}

/**
 * One feed page (newest first, keyset on `created_at, id`), fetching one
 * extra row to know whether there is a next page.
 */
export async function listNotificationRecords(
  db: DbOrTx,
  viewer: NotificationViewer,
  options: ListOptions
): Promise<{ records: NotificationRecord[]; hasMore: boolean }> {
  const keyset =
    options.cursor === null
      ? undefined
      : sql`(${notifications.createdAt}, ${notifications.id}) < (to_timestamp(0) + ${options.cursor.micros}::bigint * interval '1 microsecond', ${options.cursor.id}::uuid)`;
  const rows = await selectRecords(db, viewer, {
    where: and(keyset, options.unreadOnly ? isNull(notifications.seenAt) : undefined),
    limit: options.limit + 1
  });
  return { records: rows.slice(0, options.limit), hasMore: rows.length > options.limit };
}

/** The viewer's visible notifications with these ids (push frames). */
export async function loadNotifications(
  deps: NotificationDeps,
  viewer: NotificationViewer,
  options: { ids: readonly string[] }
): Promise<Notification[]> {
  if (options.ids.length === 0) return [];
  const records = await selectRecords(deps.db, viewer, {
    where: inArray(notifications.id, [...options.ids]),
    limit: options.ids.length
  });
  return toNotifications(deps, records);
}

/**
 * Unread visible notifications of the viewer, capped at
 * {@link NOTIFICATION_UNREAD_COUNT_MAX} (the count stops scanning there).
 */
export async function countUnread(db: DbOrTx, viewer: NotificationViewer): Promise<number> {
  const inner = db
    .select({ one: sql`1` })
    .from(notifications)
    .leftJoin(mediaItems, eq(mediaItems.id, notifications.mediaId))
    .leftJoin(events, eq(events.id, notifications.eventId))
    .leftJoin(treeLinkProposals, eq(treeLinkProposals.id, notifications.proposalId))
    .where(and(eq(notifications.userId, viewer.id), isNull(notifications.seenAt), notificationVisibleSql(viewer)))
    .limit(NOTIFICATION_UNREAD_COUNT_MAX)
    .as("unread");
  const [row] = await db.select({ value: sql<number>`count(*)::int`.mapWith(Number) }).from(inner);
  return Math.min(row?.value ?? 0, NOTIFICATION_UNREAD_COUNT_MAX);
}

/**
 * Marks the viewer's own rows read: the given ids (others' ids are simply
 * not matched) or all of them.
 */
export async function markRead(db: DbOrTx, viewer: NotificationViewer, ids: readonly string[] | "all"): Promise<void> {
  await db
    .update(notifications)
    .set({ seenAt: sql`now()` })
    .where(
      and(
        eq(notifications.userId, viewer.id),
        isNull(notifications.seenAt),
        ids === "all" ? undefined : inArray(notifications.id, [...ids])
      )
    );
}

/** Rows deleted per retention batch. */
export const RETENTION_BATCH_SIZE = 1000;

/**
 * Deletes rows older than `retentionDays` in batches (180-day retention).
 *
 * @returns How many rows were deleted.
 */
export async function purgeExpiredNotifications(db: DbOrTx, now: Date, retentionDays: number): Promise<number> {
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
  let total = 0;
  for (;;) {
    const candidates = db
      .select({ id: notifications.id })
      .from(notifications)
      .where(lt(notifications.createdAt, cutoff))
      .limit(RETENTION_BATCH_SIZE);
    const deleted = await db
      .delete(notifications)
      .where(and(inArray(notifications.id, candidates), lt(notifications.createdAt, cutoff)))
      .returning({ id: notifications.id });
    total += deleted.length;
    if (deleted.length < RETENTION_BATCH_SIZE) return total;
  }
}
