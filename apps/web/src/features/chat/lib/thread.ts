/**
 * Pure helpers for the cached conversation (`getMessages`) and room list
 * (`getRooms`). They return new values and never mutate their inputs, so they
 * work inside and outside immer drafts and are easy to unit test.
 */
import type { ChatHistoryPage, ChatMessage, ChatRoom } from "@cuencada/types";

/** Delivery state of a message in the local cache. */
export type ChatMessageStatus = "sent" | "pending" | "failed";

/** A message as cached: server messages are `sent`; optimistic ones are `pending`/`failed`. */
export interface ThreadMessage extends ChatMessage {
  /** The uuid the sender generated (`null` for other people's messages and history). */
  clientMessageId: string | null;
  status: ChatMessageStatus;
}

/** Cached conversation: oldest → newest, local pending/failed messages last. */
export interface ChatThread {
  messages: ThreadMessage[];
  /** Keyset cursor for older messages; `null` when the beginning is loaded. */
  nextBefore: string | null;
}

/** One-line preview of a room's latest message (built from frames and loaded history). */
export interface RoomPreview {
  messageId: string;
  senderName: string | null;
  senderId: string | null;
  body: string;
  deleted: boolean;
}

/** A room as cached: the contract `ChatRoom` plus the preview we know about. */
export interface ChatRoomView extends ChatRoom {
  lastMessage: RoomPreview | null;
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

function toThreadMessage(message: ChatMessage, clientMessageId: string | null = null): ThreadMessage {
  return { ...message, clientMessageId, status: "sent" };
}

function isLocal(message: ThreadMessage): boolean {
  return message.status !== "sent";
}

/** Server messages ordered by time (stable for equal timestamps), then local ones in send order. */
function ordered(messages: ThreadMessage[]): ThreadMessage[] {
  const sent = messages.filter((message) => !isLocal(message));
  const local = messages.filter(isLocal);
  const indexed = sent.map((message, index) => ({ message, index }));
  indexed.sort((a, b) => {
    const byTime = Date.parse(a.message.createdAt) - Date.parse(b.message.createdAt);
    return byTime !== 0 ? byTime : a.index - b.index;
  });
  return [...indexed.map((entry) => entry.message), ...local];
}

/** A tombstone always wins over a stale copy of the same message. */
function preferDeleted(existing: ThreadMessage, incoming: ThreadMessage): ThreadMessage {
  if (existing.deletedAt !== null && incoming.deletedAt === null) return existing;
  return { ...incoming, clientMessageId: existing.clientMessageId ?? incoming.clientMessageId };
}

/**
 * @param page - A history page from the server.
 * @returns The page as a cached thread.
 */
export function threadFromPage(page: ChatHistoryPage): ChatThread {
  return { messages: page.messages.map((message) => toThreadMessage(message)), nextBefore: page.nextBefore };
}

/**
 * Merges a freshly fetched *latest* page (a refetch after a reconnect) into
 * the cache. Older pages already loaded are kept when the new page overlaps
 * them; when it does not (more than a page was missed), the cache restarts
 * from the new page so there is never a silent hole in the history. Local
 * pending/failed messages always survive.
 *
 * @param current - What is cached.
 * @param latest - The newest page, as a thread.
 * @returns The merged thread.
 */
export function mergeLatestPage(current: ChatThread, latest: ChatThread): ChatThread {
  const local = current.messages.filter(isLocal);
  const cachedSent = current.messages.filter((message) => !isLocal(message));
  const oldestNew = latest.messages[0];
  const overlaps =
    oldestNew === undefined ||
    cachedSent.length === 0 ||
    latest.nextBefore === null ||
    cachedSent.some((message) => message.id === oldestNew.id);

  if (!overlaps) {
    const unconfirmed = local.filter((message) => !latest.messages.some((m) => m.clientMessageId !== null && m.clientMessageId === message.clientMessageId));
    return { messages: ordered([...latest.messages, ...unconfirmed]), nextBefore: latest.nextBefore };
  }

  const byId = new Map(cachedSent.map((message) => [message.id, message]));
  for (const message of latest.messages) {
    const existing = byId.get(message.id);
    byId.set(message.id, existing === undefined ? message : preferDeleted(existing, message));
  }
  return {
    messages: ordered([...byId.values(), ...local]),
    nextBefore: cachedSent.length === 0 ? latest.nextBefore : current.nextBefore
  };
}

/**
 * Adds an older history page in front of the cached messages.
 *
 * @param current - What is cached.
 * @param older - The page fetched with `before = current.nextBefore`.
 * @returns The thread with the older messages prepended (duplicates skipped).
 */
export function prependOlderPage(current: ChatThread, older: ChatHistoryPage): ChatThread {
  const known = new Set(current.messages.map((message) => message.id));
  const fresh = older.messages.filter((message) => !known.has(message.id)).map((message) => toThreadMessage(message));
  return { messages: ordered([...fresh, ...current.messages]), nextBefore: older.nextBefore };
}

/**
 * Applies a `message` frame: confirms my pending copy (matched by
 * `clientMessageId`), updates a message we already have, or adds a new one.
 * Never produces a duplicate.
 *
 * @param current - What is cached.
 * @param message - The message from the frame.
 * @param clientMessageId - The echo's `clientMessageId` (`null` for other recipients).
 * @returns The updated thread.
 */
export function applyIncomingMessage(current: ChatThread, message: ChatMessage, clientMessageId: string | null): ChatThread {
  const incoming = toThreadMessage(message, clientMessageId);
  const withoutPending =
    clientMessageId === null
      ? current.messages
      : current.messages.filter((entry) => !(isLocal(entry) && entry.clientMessageId === clientMessageId));
  const existing = withoutPending.find((entry) => entry.id === message.id);
  const next =
    existing === undefined
      ? [...withoutPending, incoming]
      : withoutPending.map((entry) => (entry.id === message.id ? preferDeleted(entry, incoming) : entry));
  return { messages: ordered(next), nextBefore: current.nextBefore };
}

/**
 * Turns a message into a tombstone (`body: ""`, `deletedAt` set).
 *
 * @param current - What is cached.
 * @param messageId - The deleted message.
 * @param deletedAt - When it was deleted (ISO). Defaults to now.
 * @returns The updated thread (unchanged if the message is not cached).
 */
export function applyDeletedMessage(current: ChatThread, messageId: string, deletedAt: string = new Date().toISOString()): ChatThread {
  if (!current.messages.some((entry) => entry.id === messageId && entry.deletedAt === null)) return current;
  return {
    messages: current.messages.map((entry) => (entry.id === messageId ? { ...entry, body: "", deletedAt } : entry)),
    nextBefore: current.nextBefore
  };
}

/**
 * Adds an optimistic message at the end.
 *
 * @param current - What is cached.
 * @param message - The local copy (`status: "pending"`).
 * @returns The updated thread.
 */
export function appendPendingMessage(current: ChatThread, message: ThreadMessage): ChatThread {
  return { messages: [...current.messages, message], nextBefore: current.nextBefore };
}

/**
 * Changes the status of a local message.
 *
 * @param current - What is cached.
 * @param clientMessageId - The local message's uuid.
 * @param status - `pending` (retrying) or `failed`.
 * @returns The updated thread (unchanged if it was already confirmed).
 */
export function setLocalStatus(current: ChatThread, clientMessageId: string, status: "pending" | "failed"): ChatThread {
  if (!current.messages.some((entry) => isLocal(entry) && entry.clientMessageId === clientMessageId)) return current;
  return {
    messages: current.messages.map((entry) => (isLocal(entry) && entry.clientMessageId === clientMessageId ? { ...entry, status } : entry)),
    nextBefore: current.nextBefore
  };
}

/**
 * Removes a local (pending/failed) message, e.g. "Descartar".
 *
 * @param current - What is cached.
 * @param clientMessageId - The local message's uuid.
 * @returns The updated thread.
 */
export function removeLocalMessage(current: ChatThread, clientMessageId: string): ChatThread {
  return {
    messages: current.messages.filter((entry) => !(isLocal(entry) && entry.clientMessageId === clientMessageId)),
    nextBefore: current.nextBefore
  };
}

/**
 * @param thread - A cached thread.
 * @returns The newest message the server has confirmed, or `undefined`.
 */
export function lastServerMessage(thread: ChatThread): ThreadMessage | undefined {
  for (let index = thread.messages.length - 1; index >= 0; index -= 1) {
    const message = thread.messages[index];
    if (message !== undefined && message.status === "sent") return message;
  }
  return undefined;
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
    deleted: message.deletedAt !== null
  };
}

/**
 * @param rooms - Rooms from `GET /chat/rooms`.
 * @param previous - What was cached before (keeps known previews across refetches).
 * @returns The cached room list: global room first, then editions newest first.
 */
export function roomsFromResponse(rooms: ChatRoom[], previous: ChatRoomView[] = []): ChatRoomView[] {
  const known = new Map(previous.map((room) => [room.id, room.lastMessage]));
  return sortRooms(rooms.map((room) => ({ ...room, lastMessage: known.get(room.id) ?? null })));
}

/**
 * @param rooms - Cached rooms.
 * @returns A sorted copy: the global room first, then editions by year (newest first), then title.
 */
export function sortRooms(rooms: ChatRoomView[]): ChatRoomView[] {
  return [...rooms].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "global" ? -1 : 1;
    const byYear = (b.year ?? 0) - (a.year ?? 0);
    return byYear !== 0 ? byYear : a.title.localeCompare(b.title, "es-MX");
  });
}

/**
 * Applies a `message` frame to the room list: newer `lastMessageAt`, the
 * preview and, for messages from other people in a room not being read
 * right now, `unreadCount + 1`.
 *
 * @param rooms - Cached rooms.
 * @param message - The message from the frame.
 * @param context - Who I am and which room is on screen.
 * @returns The updated list and whether the room was known.
 */
export function applyMessageToRooms(rooms: ChatRoomView[], message: ChatMessage, context: RoomMessageContext): RoomsUpdate {
  const room = rooms.find((entry) => entry.id === message.roomId);
  if (room === undefined) return { rooms, found: false };
  const mine = message.sender !== null && message.sender.userId === context.meId;
  const isNewer = room.lastMessageAt === null || Date.parse(message.createdAt) >= Date.parse(room.lastMessageAt);
  // An edit of a message we already previewed (or an older one) must not count twice.
  const alreadyPreviewed = room.lastMessage?.messageId === message.id;
  const countsAsUnread = !mine && isNewer && !alreadyPreviewed && context.viewingRoomId !== message.roomId;
  const updated: ChatRoomView = {
    ...room,
    lastMessageAt: isNewer ? message.createdAt : room.lastMessageAt,
    lastMessage: isNewer ? previewOf(message) : room.lastMessage,
    unreadCount: countsAsUnread ? room.unreadCount + 1 : room.unreadCount,
    lastReadMessageId: mine && isNewer ? message.id : room.lastReadMessageId
  };
  return { rooms: rooms.map((entry) => (entry.id === room.id ? updated : entry)), found: true };
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
    room.id === roomId && room.lastMessage?.messageId === messageId ? { ...room, lastMessage: { ...room.lastMessage, body: "", deleted: true } } : room
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
 * Fills a room's preview from loaded history when the list has none yet.
 *
 * @param rooms - Cached rooms.
 * @param roomId - The room whose history was loaded.
 * @param message - Its newest server message.
 * @returns The updated list.
 */
export function applyHistoryPreview(rooms: ChatRoomView[], roomId: string, message: ChatMessage): ChatRoomView[] {
  return rooms.map((room) =>
    room.id === roomId && (room.lastMessage === null || Date.parse(message.createdAt) > Date.parse(room.lastMessageAt ?? message.createdAt))
      ? { ...room, lastMessage: previewOf(message) }
      : room
  );
}

/**
 * @param rooms - Cached rooms (or `undefined` before the first answer).
 * @returns The total unread messages across rooms.
 */
export function totalUnread(rooms: readonly ChatRoomView[] | undefined): number {
  return (rooms ?? []).reduce((sum, room) => sum + room.unreadCount, 0);
}

/**
 * Where the "Nuevos mensajes" divider goes when a room is opened.
 *
 * @param messages - Cached messages, oldest → newest.
 * @param room - The room as listed (its `unreadCount` and `lastReadMessageId`).
 * @param meId - The signed-in user's id.
 * @returns The first unread message from someone else, or `null`.
 */
export function firstUnreadMessageId(
  messages: readonly ThreadMessage[],
  room: Pick<ChatRoom, "unreadCount" | "lastReadMessageId"> | undefined,
  meId: string | null
): string | null {
  if (room === undefined || room.unreadCount <= 0) return null;
  const fromOthers = (message: ThreadMessage): boolean =>
    message.status === "sent" && message.deletedAt === null && message.sender?.userId !== meId;
  if (room.lastReadMessageId !== null) {
    const readIndex = messages.findIndex((message) => message.id === room.lastReadMessageId);
    if (readIndex >= 0) return messages.slice(readIndex + 1).find(fromOthers)?.id ?? null;
  }
  const others = messages.filter(fromOthers);
  return others[Math.max(0, others.length - room.unreadCount)]?.id ?? null;
}
