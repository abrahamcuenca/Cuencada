/**
 * Chat data access: room visibility, the room list with unread counts,
 * keyset history, idempotent inserts, monotonic read state, soft delete and
 * the session checks the WebSocket uses.
 *
 * Every member can read every visible global or edition room, so those have
 * no membership rows (WP-0.3). Event rooms (WP-5.3) are limited to the
 * event's participants through `event_participants` (admins read them only
 * through the audited, read-only history: `moderationRoomSql`).
 */
import { CHAT_UNREAD_COUNT_MAX, type ChatRoomKind, type EventRef, type UserRole } from "@cuencada/types";
import { and, desc, eq, inArray, isNull, type SQL, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  chatMessages,
  chatReadStates,
  chatRooms,
  cuencadas,
  eventParticipants,
  events,
  profiles,
  sessions,
  users
} from "../../db/schema/index.js";
import type { DbOrTx } from "../../lib/audit.js";
import { type EventViewer, eventChatAccessSql, eventMemberAccessSql } from "../events/access.js";
import { type ChatCursor, decodeChatCursor } from "./cursor.js";

/** `created_at` as epoch microseconds (keyset cursor). */
const cursorMicrosSql = sql<string>`(extract(epoch from ${chatMessages.createdAt}) * 1000000)::bigint::text`;

/** Alias of `events` for the visibility subquery (the outer query joins the real table). */
const roomEvent = alias(events, "room_event");

/** SQL: the global room, or an edition room whose edition is published and not historical. */
function memberRoomSql(): SQL {
  return sql`(${chatRooms.kind} = 'global' or exists (
    select 1 from ${cuencadas}
    where ${cuencadas.id} = ${chatRooms.cuencadaId} and ${cuencadas.isPublished} and not ${cuencadas.isHistorical}
  ))`;
}

/**
 * SQL [SEC]: rooms the viewer takes part in: the room list, every inbound
 * socket frame (`send`, `typing`, `read`) and the REST read marker.
 * - The global room and rooms whose edition is published and not historical.
 *   An unpublished edition's room keeps its history but is hidden; so is the
 *   room of an edition later marked historical (WP-5.1: kept, never deleted,
 *   hidden from the list, by id and on the socket).
 * - WP-5.3: an event's room only for its **participants** while the event is
 *   visible to them (`eventChatAccessSql`). Admins are no exception (PR #54
 *   Security M1): a non-participant admin never lists, receives or writes an
 *   event chat; they moderate through {@link moderationRoomSql}.
 *
 * @param viewer - The caller (id + database role).
 */
export function visibleRoomSql(viewer: EventViewer): SQL {
  return sql`(${memberRoomSql()} or (${chatRooms.kind} = 'event' and exists (
    select 1 from ${events} room_event
    where ${roomEvent.id} = ${chatRooms.eventId} and ${eventChatAccessSql(viewer, roomEvent)}
  )))`;
}

/**
 * SQL [SEC]: rooms the viewer may **read as a moderator**: everything
 * {@link visibleRoomSql} allows plus, for admins, every event room. Used only
 * by the read-only history (audited `event.admin_viewed` for non-participant
 * admins on `participants` events) and the message delete (audited when an
 * admin deletes someone else's message).
 */
export function moderationRoomSql(viewer: EventViewer): SQL {
  return sql`(${memberRoomSql()} or (${chatRooms.kind} = 'event' and exists (
    select 1 from ${events} room_event
    where ${roomEvent.id} = ${chatRooms.eventId} and ${eventMemberAccessSql(viewer, roomEvent)}
  )))`;
}

/** A room as stored, plus its edition year or its event. */
export interface RoomRecord {
  id: string;
  kind: ChatRoomKind;
  cuencadaId: string | null;
  year: number | null;
  title: string | null;
  /** WP-5.3: the event of an `event` room (only loaded for viewers who may see it). */
  event: EventRef | null;
}

const roomColumns = {
  id: chatRooms.id,
  kind: chatRooms.kind,
  cuencadaId: chatRooms.cuencadaId,
  year: cuencadas.year,
  title: chatRooms.title,
  eventId: events.id,
  eventYear: events.year,
  eventSlug: events.slug,
  eventTitle: events.title
};

type RoomRow = Omit<RoomRecord, "event"> & {
  eventId: string | null;
  eventYear: number | null;
  eventSlug: string | null;
  eventTitle: string | null;
};

function toRoomRecord<TRow extends RoomRow>(row: TRow): Omit<TRow, "eventId" | "eventYear" | "eventSlug" | "eventTitle"> & { event: EventRef | null } {
  const { eventId, eventYear, eventSlug, eventTitle, ...rest } = row;
  const event =
    eventId !== null && eventYear !== null && eventSlug !== null && eventTitle !== null
      ? { id: eventId, year: eventYear, slug: eventSlug, title: eventTitle }
      : null;
  return { ...rest, event };
}

/**
 * Load a room if the viewer may see it. Every REST read and every inbound
 * socket frame calls this, so access is re-checked each time.
 *
 * @returns The room, or `null` for unknown and hidden rooms (callers answer 404).
 */
export async function findVisibleRoom(db: DbOrTx, roomId: string, viewer: EventViewer): Promise<RoomRecord | null> {
  return findRoomWhere(db, roomId, visibleRoomSql(viewer));
}

/**
 * Load a room the viewer may read as a moderator ({@link moderationRoomSql}):
 * REST history and message delete only.
 *
 * @returns The room, or `null` (callers answer 404).
 */
export async function findModerationRoom(db: DbOrTx, roomId: string, viewer: EventViewer): Promise<RoomRecord | null> {
  return findRoomWhere(db, roomId, moderationRoomSql(viewer));
}

async function findRoomWhere(db: DbOrTx, roomId: string, rule: SQL): Promise<RoomRecord | null> {
  const [row] = await db
    .select(roomColumns)
    .from(chatRooms)
    .leftJoin(cuencadas, eq(cuencadas.id, chatRooms.cuencadaId))
    .leftJoin(events, eq(events.id, chatRooms.eventId))
    .where(and(eq(chatRooms.id, roomId), rule))
    .limit(1);
  return row === undefined ? null : toRoomRecord(row);
}

/** Who may receive a room's frames (see `ChatHub.fanOutRoom`). */
export type RoomAudience =
  /** Global and edition rooms: every connected member (their visibility is checked on each inbound frame). */
  | { kind: "everyone" }
  /** Event rooms: these users only (participants with chat access; no non-participant admins). */
  | { kind: "users"; userIds: ReadonlySet<string> };

/** The empty audience (a deleted or unknown room). */
export const NO_AUDIENCE: RoomAudience = { kind: "users", userIds: new Set() };

/**
 * Load a room's audience from the database [SEC]. Event rooms: the
 * participants who may currently use the chat, i.e. `eventChatAccessSql`
 * evaluated for all users at once: published → every participant; draft →
 * organizers; hidden → nobody, except participants who are active admins
 * (they see every event). Non-participant admins are never in it (PR #54 M1).
 *
 * @returns The audience; an unknown room has {@link NO_AUDIENCE}.
 */
export async function loadRoomAudience(db: DbOrTx, roomId: string): Promise<RoomAudience> {
  const [room] = await db
    .select({ kind: chatRooms.kind, eventId: chatRooms.eventId })
    .from(chatRooms)
    .where(eq(chatRooms.id, roomId))
    .limit(1);
  if (room === undefined) return NO_AUDIENCE;
  if (room.kind !== "event" || room.eventId === null) return { kind: "everyone" };
  const rows = await db.execute<{ user_id: string }>(sql`
    select ep.user_id::text as user_id
    from ${eventParticipants} ep
    inner join ${events} e on e.id = ep.event_id
    where ep.event_id = ${room.eventId}::uuid
      and (e.status = 'published'
        or (e.status = 'draft' and ep.role = 'organizer')
        or exists (select 1 from ${users} u where u.id = ep.user_id and u.role = 'admin' and u.status = 'active'))
  `);
  return { kind: "users", userIds: new Set(rows.map((row) => row.user_id)) };
}

/** The id of an event's chat room, if it has one. */
export async function eventRoomId(db: DbOrTx, eventId: string): Promise<string | null> {
  const [row] = await db
    .select({ id: chatRooms.id })
    .from(chatRooms)
    .where(and(eq(chatRooms.kind, "event"), eq(chatRooms.eventId, eventId)))
    .limit(1);
  return row?.id ?? null;
}

/** One row of the room list before mapping. */
export interface RoomListRecord extends RoomRecord {
  createdAt: Date;
  lastReadMessageId: string | null;
  unreadCount: number;
}

/**
 * Visible rooms with the caller's read state and unread count: live messages
 * from other members after the last-read message, capped at
 * {@link CHAT_UNREAD_COUNT_MAX} so a never-read busy room stays cheap.
 *
 * @param viewer - The caller (event rooms follow ADR 0001 §7).
 */
export async function listVisibleRooms(db: DbOrTx, viewer: EventViewer): Promise<RoomListRecord[]> {
  const userId = viewer.id;
  const lastRead = alias(chatMessages, "last_read");
  const rows = await db
    .select({
      ...roomColumns,
      createdAt: chatRooms.createdAt,
      lastReadMessageId: chatReadStates.lastReadMessageId,
      unreadCount: sql<number>`(select count(*)::int from (
        select 1 from ${chatMessages} m
        where m.room_id = ${chatRooms.id}
          and m.deleted_at is null
          and m.sender_user_id is distinct from ${userId}::uuid
          and (${lastRead.id} is null or (m.created_at, m.id) > (${lastRead.createdAt}, ${lastRead.id}))
        limit ${CHAT_UNREAD_COUNT_MAX}
      ) as unread)`.mapWith(Number)
    })
    .from(chatRooms)
    .leftJoin(cuencadas, eq(cuencadas.id, chatRooms.cuencadaId))
    .leftJoin(events, eq(events.id, chatRooms.eventId))
    .leftJoin(chatReadStates, and(eq(chatReadStates.roomId, chatRooms.id), eq(chatReadStates.userId, userId)))
    .leftJoin(lastRead, eq(lastRead.id, chatReadStates.lastReadMessageId))
    .where(visibleRoomSql(viewer));
  return rows.map(toRoomRecord);
}

/** The newest live message of a room. */
export interface LastMessageRecord {
  roomId: string;
  id: string;
  body: string;
  createdAt: Date;
  senderUserId: string | null;
  senderDisplayName: string | null;
}

/**
 * Newest live message per room, one `DISTINCT ON` query for all rooms
 * (served by the `(room_id, created_at desc, id desc)` index).
 */
export async function lastMessagesFor(db: DbOrTx, roomIds: readonly string[]): Promise<LastMessageRecord[]> {
  if (roomIds.length === 0) return [];
  return db
    .selectDistinctOn([chatMessages.roomId], {
      roomId: chatMessages.roomId,
      id: chatMessages.id,
      body: chatMessages.body,
      createdAt: chatMessages.createdAt,
      senderUserId: chatMessages.senderUserId,
      senderDisplayName: users.displayName
    })
    .from(chatMessages)
    .leftJoin(users, eq(users.id, chatMessages.senderUserId))
    .where(and(inArray(chatMessages.roomId, [...roomIds]), isNull(chatMessages.deletedAt)))
    .orderBy(chatMessages.roomId, desc(chatMessages.createdAt), desc(chatMessages.id));
}

/** A message with what the contract needs about its sender. */
export interface MessageRecord {
  id: string;
  roomId: string;
  senderUserId: string | null;
  senderDisplayName: string | null;
  senderAvatarKey: string | null;
  body: string;
  clientMessageId: string | null;
  createdAt: Date;
  deletedAt: Date | null;
  cursorMicros: string;
}

function selectMessages(db: DbOrTx) {
  return db
    .select({
      id: chatMessages.id,
      roomId: chatMessages.roomId,
      senderUserId: chatMessages.senderUserId,
      senderDisplayName: users.displayName,
      senderAvatarKey: profiles.avatarKey,
      body: chatMessages.body,
      clientMessageId: chatMessages.clientMessageId,
      createdAt: chatMessages.createdAt,
      deletedAt: chatMessages.deletedAt,
      cursorMicros: cursorMicrosSql
    })
    .from(chatMessages)
    .leftJoin(users, eq(users.id, chatMessages.senderUserId))
    .leftJoin(profiles, eq(profiles.userId, chatMessages.senderUserId));
}

function beforeCursorSql(cursor: ChatCursor): SQL {
  return sql`(${chatMessages.createdAt}, ${chatMessages.id}) < (to_timestamp(0) + ${cursor.micros}::bigint * interval '1 microsecond', ${cursor.id}::uuid)`;
}

/** One history page, newest first as loaded. */
export interface HistoryRecords {
  /** Oldest → newest. */
  records: MessageRecord[];
  /** The oldest returned row when older rows exist, else `null`. */
  oldest: MessageRecord | null;
}

/**
 * Keyset page: `(created_at, id) < before`, `order by created_at desc, id desc`,
 * `limit + 1` to know whether an older page exists.
 *
 * @param before - Raw cursor from the query string (validated here).
 * @throws AppError VALIDATION for a cursor this server did not produce.
 */
export async function historyPage(
  db: DbOrTx,
  roomId: string,
  before: string | undefined,
  limit: number
): Promise<HistoryRecords> {
  const conditions: SQL[] = [eq(chatMessages.roomId, roomId)];
  if (before !== undefined) conditions.push(beforeCursorSql(decodeChatCursor(before)));
  const rows = await selectMessages(db)
    .where(and(...conditions))
    .orderBy(desc(chatMessages.createdAt), desc(chatMessages.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const oldest = rows.length > limit ? (page.at(-1) ?? null) : null;
  return { records: page.reverse(), oldest };
}

/** Load one message with its sender. */
export async function findMessage(db: DbOrTx, messageId: string): Promise<MessageRecord | null> {
  const [row] = await selectMessages(db).where(eq(chatMessages.id, messageId)).limit(1);
  return row ?? null;
}

/** Input of {@link insertMessageIdempotent}. */
export interface NewMessage {
  roomId: string;
  senderUserId: string;
  body: string;
  clientMessageId: string;
}

/** Outcome of {@link insertMessageIdempotent}. */
export interface InsertOutcome {
  message: MessageRecord;
  /** `false` when `(sender, client_message_id)` already existed (a retry). */
  created: boolean;
}

/**
 * Insert a message once per `(sender, client_message_id)`. A retry returns the
 * stored message (possibly in another room or already deleted) and inserts
 * nothing. `created_at` is the database clock, so concurrent sends keep a
 * strict, microsecond order.
 */
export async function insertMessageIdempotent(db: DbOrTx, input: NewMessage): Promise<InsertOutcome> {
  const [inserted] = await db
    .insert(chatMessages)
    .values(input)
    .onConflictDoNothing({
      target: [chatMessages.senderUserId, chatMessages.clientMessageId],
      where: sql`client_message_id is not null`
    })
    .returning({ id: chatMessages.id });
  if (inserted !== undefined) {
    const message = await findMessage(db, inserted.id);
    if (message === null) throw new Error("chat: inserted message vanished");
    return { message, created: true };
  }
  const [existing] = await selectMessages(db)
    .where(
      and(eq(chatMessages.senderUserId, input.senderUserId), eq(chatMessages.clientMessageId, input.clientMessageId))
    )
    .limit(1);
  if (existing === undefined) throw new Error("chat: duplicate client message id without a row");
  return { message: existing, created: false };
}

/**
 * Move the caller's read marker to `messageId`, never backwards: the upsert
 * only replaces a marker that is older in `(created_at, id)` order.
 *
 * @returns `false` when the message is not in the room (callers answer 404).
 */
export async function markRead(
  db: DbOrTx,
  input: { roomId: string; userId: string; messageId: string; now: Date }
): Promise<boolean> {
  const [target] = await db
    .select({ id: chatMessages.id })
    .from(chatMessages)
    .where(and(eq(chatMessages.id, input.messageId), eq(chatMessages.roomId, input.roomId)))
    .limit(1);
  if (target === undefined) return false;
  await db
    .insert(chatReadStates)
    .values({
      roomId: input.roomId,
      userId: input.userId,
      lastReadMessageId: input.messageId,
      lastReadAt: input.now,
      updatedAt: input.now
    })
    .onConflictDoUpdate({
      target: [chatReadStates.roomId, chatReadStates.userId],
      set: {
        lastReadMessageId: input.messageId,
        lastReadAt: input.now,
        updatedAt: input.now
      },
      setWhere: sql`not exists (
        select 1 from ${chatMessages} cur, ${chatMessages} nm
        where cur.id = ${chatReadStates.lastReadMessageId}
          and nm.id = ${input.messageId}::uuid
          and (cur.created_at, cur.id) >= (nm.created_at, nm.id)
      )`
    });
  return true;
}

/**
 * Soft-delete a live message.
 *
 * @returns The room id when this call deleted it, `null` if it was already deleted.
 */
export async function softDeleteMessage(
  db: DbOrTx,
  input: { messageId: string; actorUserId: string; now: Date }
): Promise<string | null> {
  const [row] = await db
    .update(chatMessages)
    .set({ deletedAt: input.now, deletedByUserId: input.actorUserId })
    .where(and(eq(chatMessages.id, input.messageId), isNull(chatMessages.deletedAt)))
    .returning({ roomId: chatMessages.roomId });
  return row?.roomId ?? null;
}

/** Who a chat socket belongs to, loaded from the database. */
export interface ChatPrincipal {
  userId: string;
  sessionId: string;
  displayName: string;
  /**
   * Database role at connect time. Event-room access (`findVisibleRoom`) reads
   * it; a role change closes the user's sockets (admin user routes), so a
   * demoted admin reconnects with the new role.
   */
  role: UserRole;
  /**
   * `profiles.listed_in_directory` ("Aparecer en el directorio"). Unlisted
   * members are left out of presence; refreshed by the periodic re-check.
   */
  listedInDirectory: boolean;
}

/** SQL: the session is live and its user may use chat (same rules as the REST guard + verified email). */
function usableSessionSql(now: Date): SQL {
  const at = sql`${now.toISOString()}::timestamptz`;
  return sql`(${sessions.revokedAt} is null
    and ${sessions.idleExpiresAt} > ${at}
    and ${sessions.absoluteExpiresAt} > ${at}
    and ${users.status} = 'active'
    and ${users.emailVerifiedAt} is not null
    and not ${users.mustChangePassword})`;
}

/** SQL: the user is listed in the directory (no profile row → unlisted, fail closed). */
const listedSql = sql<boolean>`coalesce(${profiles.listedInDirectory}, false)`;

/**
 * Load the principal for a ticket: the session must be live, belong to
 * `userId`, and its user must be active, verified and not pending a password
 * change.
 *
 * @returns The principal, or `null` (the socket is closed with 1008).
 */
export async function loadPrincipal(
  db: DbOrTx,
  input: { sessionId: string; userId: string; now: Date }
): Promise<ChatPrincipal | null> {
  const [row] = await db
    .select({ userId: sessions.userId, displayName: users.displayName, role: users.role, listedInDirectory: listedSql })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .leftJoin(profiles, eq(profiles.userId, sessions.userId))
    .where(and(eq(sessions.id, input.sessionId), eq(sessions.userId, input.userId), usableSessionSql(input.now)))
    .limit(1);
  if (row === undefined) return null;
  return {
    userId: row.userId,
    sessionId: input.sessionId,
    displayName: row.displayName,
    role: row.role,
    listedInDirectory: row.listedInDirectory
  };
}

/**
 * Of `sessionIds`, the ones that are still usable for chat, with each user's
 * current directory listing.
 *
 * @returns `sessionId → listedInDirectory` for sessions to keep; every other connected session must be closed.
 */
export async function usableSessions(
  db: DbOrTx,
  sessionIds: readonly string[],
  now: Date
): Promise<Map<string, boolean>> {
  if (sessionIds.length === 0) return new Map();
  const rows = await db
    .select({ id: sessions.id, listedInDirectory: listedSql })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .leftJoin(profiles, eq(profiles.userId, sessions.userId))
    .where(and(inArray(sessions.id, [...sessionIds]), usableSessionSql(now)));
  return new Map(rows.map((row) => [row.id, row.listedInDirectory]));
}
