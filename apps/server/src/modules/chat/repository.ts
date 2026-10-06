/**
 * Chat data access: room visibility, the room list with unread counts,
 * keyset history, idempotent inserts, monotonic read state, soft delete and
 * the session checks the WebSocket uses.
 *
 * Every member can read every visible room (the global room and the rooms of
 * published editions), so there are no membership rows (WP-0.3).
 */
import { CHAT_UNREAD_COUNT_MAX, type ChatRoomKind } from "@cuencada/types";
import { and, desc, eq, inArray, isNull, type SQL, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  chatMessages,
  chatReadStates,
  chatRooms,
  cuencadas,
  profiles,
  sessions,
  users
} from "../../db/schema/index.js";
import type { DbOrTx } from "../../lib/audit.js";
import { type ChatCursor, decodeChatCursor } from "./cursor.js";

/** `created_at` as epoch microseconds (keyset cursor). */
const cursorMicrosSql = sql<string>`(extract(epoch from ${chatMessages.createdAt}) * 1000000)::bigint::text`;

/**
 * SQL: rooms members may see, i.e. the global room and rooms whose edition is
 * published. An unpublished edition's room keeps its history but is hidden.
 */
export function visibleRoomSql(): SQL {
  return sql`(${chatRooms.kind} = 'global' or exists (
    select 1 from ${cuencadas} where ${cuencadas.id} = ${chatRooms.cuencadaId} and ${cuencadas.isPublished}
  ))`;
}

/** A room as stored, plus its edition year. */
export interface RoomRecord {
  id: string;
  kind: ChatRoomKind;
  cuencadaId: string | null;
  year: number | null;
  title: string | null;
}

/**
 * Load a room if members may see it.
 *
 * @returns The room, or `null` for unknown and hidden rooms (callers answer 404).
 */
export async function findVisibleRoom(db: DbOrTx, roomId: string): Promise<RoomRecord | null> {
  const [row] = await db
    .select({
      id: chatRooms.id,
      kind: chatRooms.kind,
      cuencadaId: chatRooms.cuencadaId,
      year: cuencadas.year,
      title: chatRooms.title
    })
    .from(chatRooms)
    .leftJoin(cuencadas, eq(cuencadas.id, chatRooms.cuencadaId))
    .where(and(eq(chatRooms.id, roomId), visibleRoomSql()))
    .limit(1);
  return row ?? null;
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
 * @param userId - The caller.
 */
export async function listVisibleRooms(db: DbOrTx, userId: string): Promise<RoomListRecord[]> {
  const lastRead = alias(chatMessages, "last_read");
  return db
    .select({
      id: chatRooms.id,
      kind: chatRooms.kind,
      cuencadaId: chatRooms.cuencadaId,
      year: cuencadas.year,
      title: chatRooms.title,
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
    .leftJoin(chatReadStates, and(eq(chatReadStates.roomId, chatRooms.id), eq(chatReadStates.userId, userId)))
    .leftJoin(lastRead, eq(lastRead.id, chatReadStates.lastReadMessageId))
    .where(visibleRoomSql());
}

/** The newest live message of a room. */
export interface LastMessageRecord {
  roomId: string;
  id: string;
  body: string;
  createdAt: Date;
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
    .select({ userId: sessions.userId, displayName: users.displayName })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.id, input.sessionId), eq(sessions.userId, input.userId), usableSessionSql(input.now)))
    .limit(1);
  if (row === undefined) return null;
  return {
    userId: row.userId,
    sessionId: input.sessionId,
    displayName: row.displayName
  };
}

/**
 * Of `sessionIds`, the ones that are still usable for chat.
 *
 * @returns The ids to keep; every other connected session must be closed.
 */
export async function usableSessionIds(db: DbOrTx, sessionIds: readonly string[], now: Date): Promise<Set<string>> {
  if (sessionIds.length === 0) return new Set();
  const rows = await db
    .select({ id: sessions.id })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(inArray(sessions.id, [...sessionIds]), usableSessionSql(now)));
  return new Set(rows.map((row) => row.id));
}
