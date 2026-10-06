/**
 * Row → contract mappers for chat. Deleted messages become tombstones:
 * `body: ""` with `deletedAt` set, so the stored body never leaves the server.
 */
import {
  CHAT_PREVIEW_MAX_LENGTH,
  type ChatMessage,
  type ChatRoom,
  type ChatRoomLastMessage,
  ChatRoomKind
} from "@cuencada/types";
import { type AvatarDeps, avatarUrlsFor } from "./avatars.js";
import type { LastMessageRecord, MessageRecord, RoomListRecord, RoomRecord } from "./repository.js";

/** Title shown when a room row has none. */
export function roomTitle(room: Pick<RoomRecord, "kind" | "year" | "title">): string {
  if (room.title !== null && room.title.trim() !== "") return room.title;
  return room.kind === ChatRoomKind.Global || room.year === null ? "Chat familiar" : `Cuencada ${room.year}`;
}

/**
 * One-line preview: whitespace collapsed, cut on a code-point boundary so the
 * result (with `…`) fits {@link CHAT_PREVIEW_MAX_LENGTH} UTF-16 units.
 */
export function previewOf(body: string): string {
  const flat = body.replace(/\s+/g, " ").trim();
  if (flat.length <= CHAT_PREVIEW_MAX_LENGTH) return flat;
  let out = "";
  for (const char of flat) {
    if (out.length + char.length > CHAT_PREVIEW_MAX_LENGTH - 1) break;
    out += char;
  }
  return `${out.trimEnd()}…`;
}

/** Map a message, using pre-signed avatar URLs keyed by `avatar_key`. */
export function toChatMessage(record: MessageRecord, avatars: ReadonlyMap<string, string | null>): ChatMessage {
  const deleted = record.deletedAt !== null;
  return {
    id: record.id,
    roomId: record.roomId,
    sender:
      record.senderUserId === null || record.senderDisplayName === null
        ? null
        : {
            userId: record.senderUserId,
            displayName: record.senderDisplayName,
            avatarUrl: record.senderAvatarKey === null ? null : (avatars.get(record.senderAvatarKey) ?? null)
          },
    body: deleted ? "" : record.body,
    createdAt: record.createdAt.toISOString(),
    deletedAt: record.deletedAt?.toISOString() ?? null
  };
}

/** Map messages, presigning each distinct sender avatar once. */
export async function toChatMessages(deps: AvatarDeps, records: readonly MessageRecord[]): Promise<ChatMessage[]> {
  const avatars = await avatarUrlsFor(
    deps,
    records.map((record) => record.senderAvatarKey)
  );
  return records.map((record) => toChatMessage(record, avatars));
}

function toLastMessage(record: LastMessageRecord): ChatRoomLastMessage {
  return {
    id: record.id,
    senderDisplayName: record.senderDisplayName,
    preview: previewOf(record.body),
    createdAt: record.createdAt.toISOString()
  };
}

/**
 * Build the room list, most recent activity first; rooms without messages
 * follow (global first, then newest edition).
 */
export function toChatRooms(rooms: readonly RoomListRecord[], lastMessages: readonly LastMessageRecord[]): ChatRoom[] {
  const lastByRoom = new Map(lastMessages.map((record) => [record.roomId, record]));
  const mapped = rooms.map((room): ChatRoom => {
    const last = lastByRoom.get(room.id);
    return {
      id: room.id,
      kind: room.kind,
      cuencadaId: room.cuencadaId,
      year: room.year,
      title: roomTitle(room),
      unreadCount: room.unreadCount,
      lastMessageAt: last?.createdAt.toISOString() ?? null,
      lastReadMessageId: room.lastReadMessageId,
      lastMessage: last === undefined ? null : toLastMessage(last)
    };
  });
  return mapped.sort(compareRooms);
}

function compareRooms(a: ChatRoom, b: ChatRoom): number {
  if (a.lastMessageAt !== b.lastMessageAt) {
    if (a.lastMessageAt === null) return 1;
    if (b.lastMessageAt === null) return -1;
    return a.lastMessageAt < b.lastMessageAt ? 1 : -1;
  }
  if (a.kind !== b.kind) return a.kind === ChatRoomKind.Global ? -1 : 1;
  return (b.year ?? 0) - (a.year ?? 0);
}
