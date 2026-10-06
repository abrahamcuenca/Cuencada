/**
 * Pure helpers for the cached room list (`getRooms`). They return new values
 * and never mutate their inputs, so they work inside and outside immer drafts.
 * Part of the initial chunk (the Chat tab badge): keep it small and free of
 * value imports from `@cuencada/types` (see `limits.ts`).
 */
import type { ChatMessage, ChatRoom, ChatRoomLastMessage } from "@cuencada/types";
import { UNREAD_COUNT_MAX } from "./limits";

/** One-line preview of a room's latest message (from the server, frames or loaded history). */
export interface RoomPreview {
  messageId: string;
  senderName: string | null;
  /** Known only from frames and history (the room list gives just the name). */
  senderId: string | null;
  body: string;
  createdAt: string;
  deleted: boolean;
}

/** A room as cached: the contract `ChatRoom`, with its `lastMessage` turned into a {@link RoomPreview}. */
export interface ChatRoomView extends Omit<ChatRoom, "lastMessage"> {
  preview: RoomPreview | null;
}

/** Options for {@link applyMessageToRooms}. */
export interface RoomMessageContext {
  /** The signed-in user's id; their own messages never count as unread. */
  meId: string | null;
  /** The room on screen and scrolled to the bottom; its messages are read right away. */
  viewingRoomId: string | null;
}

/** Result of {@link applyMessageToRooms}. */
export interface RoomsUpdate {
  rooms: ChatRoomView[];
  /** False when the message belongs to a room we do not know yet (refetch the list). */
  found: boolean;
}

/**
 * @param message - A server message.
 * @returns Its room-list preview.
 */
export function previewOf(message: ChatMessage): RoomPreview {
  return {
    messageId: message.id,
    senderName: message.sender?.displayName ?? null,
    senderId: message.sender?.userId ?? null,
    body: message.body,
    createdAt: message.createdAt,
    deleted: message.deletedAt !== null
  };
}

function previewFromRoom(room: ChatRoom): RoomPreview | null {
  const last = room.lastMessage;
  if (last === null) return null;
  return previewFromLastMessage(last);
}

function previewFromLastMessage(last: ChatRoomLastMessage): RoomPreview {
  return {
    messageId: last.id,
    senderName: last.senderDisplayName,
    senderId: last.senderUserId,
    body: last.preview,
    createdAt: last.createdAt,
    deleted: false
  };
}

/**
 * Applies a `room_preview` frame (sent after the previewed message was
 * deleted): the room's preview and `lastMessageAt` become the server's,
 * `null` when no live message is left. Unread counts are untouched.
 *
 * @param rooms - Cached rooms.
 * @param roomId - The room.
 * @param lastMessageAt - The room's new `lastMessageAt`.
 * @param lastMessage - The room's new last live message, or `null`.
 * @returns The updated, re-sorted list.
 */
export function applyRoomPreview(
  rooms: ChatRoomView[],
  roomId: string,
  lastMessageAt: string | null,
  lastMessage: ChatRoomLastMessage | null
): ChatRoomView[] {
  if (!rooms.some((room) => room.id === roomId)) return rooms;
  return sortRooms(
    rooms.map((room) => (room.id === roomId ? { ...room, lastMessageAt, preview: lastMessage === null ? null : previewFromLastMessage(lastMessage) } : room))
  );
}

function newerPreview(a: RoomPreview | null, b: RoomPreview | null): RoomPreview | null {
  if (a === null) return b;
  if (b === null) return a;
  // Same message: keep the richer copy (with the sender id).
  if (a.messageId === b.messageId) return a.senderId !== null ? a : b;
  return Date.parse(a.createdAt) >= Date.parse(b.createdAt) ? a : b;
}

/**
 * @param rooms - Rooms from `GET /chat/rooms`.
 * @returns The cached room list, sorted with {@link sortRooms}.
 */
export function roomsFromResponse(rooms: ChatRoom[]): ChatRoomView[] {
  return sortRooms(
    rooms.map((room) => {
      const { lastMessage: _lastMessage, ...rest } = room;
      return { ...rest, preview: previewFromRoom(room) };
    })
  );
}

/**
 * Merges a refetched room list into the cache: the server's counts win, but
 * a newer preview learnt from a frame survives.
 *
 * @param current - What is cached.
 * @param incoming - The refetched list (already through {@link roomsFromResponse}).
 * @returns The merged, sorted list.
 */
export function mergeRoomLists(current: ChatRoomView[], incoming: ChatRoomView[]): ChatRoomView[] {
  const known = new Map(current.map((room) => [room.id, room.preview]));
  return sortRooms(incoming.map((room) => ({ ...room, preview: newerPreview(known.get(room.id) ?? null, room.preview) })));
}

const EPOCH = "1970-01-01T00:00:00.000Z";

/**
 * @param rooms - Cached rooms.
 * @returns A sorted copy: the global room pinned first, then the most recent activity, then the newest edition.
 */
export function sortRooms(rooms: ChatRoomView[]): ChatRoomView[] {
  return [...rooms].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "global" ? -1 : 1;
    const byActivity = Date.parse(b.lastMessageAt ?? EPOCH) - Date.parse(a.lastMessageAt ?? EPOCH);
    if (byActivity !== 0) return byActivity;
    const byYear = (b.year ?? 0) - (a.year ?? 0);
    return byYear !== 0 ? byYear : a.title.localeCompare(b.title, "es-MX");
  });
}

/**
 * Applies a `message` frame to the room list: newer `lastMessageAt`, the
 * preview and, for messages from other people in a room not being read
 * right now, `unreadCount + 1` (capped like the server's count).
 *
 * @param rooms - Cached rooms.
 * @param message - The message from the frame.
 * @param context - Who I am and which room is on screen.
 * @returns The updated (re-sorted) list and whether the room was known.
 */
export function applyMessageToRooms(rooms: ChatRoomView[], message: ChatMessage, context: RoomMessageContext): RoomsUpdate {
  const room = rooms.find((entry) => entry.id === message.roomId);
  if (room === undefined) return { rooms, found: false };
  const mine = message.sender !== null && message.sender.userId === context.meId;
  const isNewer = room.lastMessageAt === null || Date.parse(message.createdAt) >= Date.parse(room.lastMessageAt);
  // A message we already previewed (an idempotent resend, a replay) must not count twice.
  const alreadyPreviewed = room.preview?.messageId === message.id;
  const countsAsUnread = !mine && isNewer && !alreadyPreviewed && context.viewingRoomId !== message.roomId;
  const updated: ChatRoomView = {
    ...room,
    lastMessageAt: isNewer ? message.createdAt : room.lastMessageAt,
    preview: isNewer ? previewOf(message) : room.preview,
    unreadCount: countsAsUnread ? Math.min(UNREAD_COUNT_MAX, room.unreadCount + 1) : room.unreadCount,
    lastReadMessageId: mine && isNewer ? message.id : room.lastReadMessageId
  };
  return { rooms: sortRooms(rooms.map((entry) => (entry.id === room.id ? updated : entry))), found: true };
}

/**
 * Marks a room's preview as deleted when the deleted message is the one shown.
 *
 * @param rooms - Cached rooms.
 * @param roomId - The room of the deleted message.
 * @param messageId - The deleted message.
 * @returns The updated list.
 */
export function applyDeletedToRooms(rooms: ChatRoomView[], roomId: string, messageId: string): ChatRoomView[] {
  return rooms.map((room) =>
    room.id === roomId && room.preview !== null && room.preview.messageId === messageId
      ? { ...room, preview: { ...room.preview, body: "", deleted: true } }
      : room
  );
}

/**
 * Records that I read a room up to `messageId`.
 *
 * @param rooms - Cached rooms.
 * @param roomId - The room.
 * @param messageId - The newest message I have seen.
 * @returns The updated list with `unreadCount: 0`.
 */
export function applyReadToRooms(rooms: ChatRoomView[], roomId: string, messageId: string): ChatRoomView[] {
  return rooms.map((room) => (room.id === roomId ? { ...room, unreadCount: 0, lastReadMessageId: messageId } : room));
}

/**
 * Updates a room's preview from its loaded history when that is newer (or
 * the same message with the sender id, so "Tú:" can be shown).
 *
 * @param rooms - Cached rooms.
 * @param roomId - The room whose history was loaded.
 * @param message - Its newest server message.
 * @returns The updated list.
 */
export function applyHistoryPreview(rooms: ChatRoomView[], roomId: string, message: ChatMessage): ChatRoomView[] {
  return rooms.map((room) => (room.id === roomId ? { ...room, preview: newerPreview(previewOf(message), room.preview) } : room));
}

/**
 * @param rooms - Cached rooms (or `undefined` before the first answer).
 * @returns The total unread messages across rooms.
 */
export function totalUnread(rooms: readonly ChatRoomView[] | undefined): number {
  return (rooms ?? []).reduce((sum, room) => sum + room.unreadCount, 0);
}
