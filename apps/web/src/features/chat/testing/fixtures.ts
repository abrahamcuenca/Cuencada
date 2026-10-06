/**
 * Chat test fixtures: fictional people, rooms and messages, an in-memory
 * chat "server" for MSW (rooms, keyset history, read, ticket, delete) and
 * frame builders. Used by the tests and the screenshot stub. Every name is
 * invented (public repo).
 */
import type { ChatMessage, ChatRoom, ChatSender, WsServerMessage } from "@cuencada/types";
import { type HttpHandler, HttpResponse, http } from "msw";
import { apiUrl, errorBody } from "../../../../test/auth";

/** A deterministic v4-shaped UUID for fixture `n` in a namespace digit. */
export function chatId(namespace: number, n: number): string {
  return `${String(namespace).repeat(8)}-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

/** The signed-in user in tests: matches `makeUser()` from `test/auth.ts`. */
export const ME: ChatSender = { userId: "6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b", displayName: "Prima Morales", avatarUrl: null };

/** Other (fictional) family members. */
export const PEOPLE = {
  lucia: { userId: chatId(2, 1), displayName: "Lucía Ramírez Solís", avatarUrl: null },
  tomas: { userId: chatId(2, 2), displayName: "Tomás Herrera Vidal", avatarUrl: null },
  marta: { userId: chatId(2, 3), displayName: "Marta Ibáñez Ríos", avatarUrl: null }
} as const satisfies Record<string, ChatSender>;

/** Room ids. */
export const ROOMS = {
  familia: chatId(1, 1),
  y2026: chatId(1, 2),
  y2025: chatId(1, 3)
} as const;

/** A valid single-use ticket shape (≥ 32 chars). */
export function ticketValue(n: number): string {
  return `tkt${String(n).padStart(4, "0")}${"x".repeat(40)}`;
}

/**
 * @param n - Message number (also orders `createdAt`).
 * @param overrides - Fields to change.
 * @returns A contract `ChatMessage` in the global room.
 */
export function makeMessage(n: number, overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: chatId(3, n),
    roomId: ROOMS.familia,
    sender: PEOPLE.lucia,
    body: `Mensaje ${n}`,
    createdAt: new Date(Date.UTC(2026, 8, 14, 15, 0, 0) + n * 60_000).toISOString(),
    deletedAt: null,
    ...overrides
  };
}

/** @returns The three rooms: the global one plus two editions. */
export function makeRooms(overrides: Partial<Record<keyof typeof ROOMS, Partial<ChatRoom>>> = {}): ChatRoom[] {
  return [
    {
      id: ROOMS.y2025,
      kind: "cuencada",
      cuencadaId: chatId(4, 1),
      year: 2025,
      title: "Cuencada 2025",
      unreadCount: 0,
      lastMessageAt: "2025-09-20T18:00:00.000Z",
      lastReadMessageId: null,
      lastMessage: {
        id: chatId(3, 900),
        senderUserId: PEOPLE.marta.userId,
        senderDisplayName: PEOPLE.marta.displayName,
        preview: "¡Gracias por todo, familia!",
        createdAt: "2025-09-20T18:00:00.000Z"
      },
      ...overrides.y2025
    },
    {
      id: ROOMS.familia,
      kind: "global",
      cuencadaId: null,
      year: null,
      title: "Toda la familia",
      unreadCount: 3,
      lastMessageAt: "2026-09-14T15:05:00.000Z",
      lastReadMessageId: null,
      lastMessage: {
        id: chatId(3, 5),
        senderUserId: PEOPLE.lucia.userId,
        senderDisplayName: PEOPLE.lucia.displayName,
        preview: "Mensaje 5",
        createdAt: "2026-09-14T15:05:00.000Z"
      },
      ...overrides.familia
    },
    {
      id: ROOMS.y2026,
      kind: "cuencada",
      cuencadaId: chatId(4, 2),
      year: 2026,
      title: "Cuencada 2026",
      unreadCount: 0,
      lastMessageAt: null,
      lastReadMessageId: null,
      lastMessage: null,
      ...overrides.y2026
    }
  ];
}

/** Mutable state behind the MSW handlers. */
export interface ChatDb {
  rooms: ChatRoom[];
  /** Messages per room, oldest → newest. */
  messages: Map<string, ChatMessage[]>;
  tickets: string[];
  reads: { roomId: string; messageId: string }[];
  deleted: string[];
  historyRequests: { roomId: string; before: string | null; limit: number }[];
  /** Status to answer `POST /chat/ticket` with (201 by default). */
  ticketStatus: 201 | 403 | 500;
  /** Status to answer rooms/history with (200 by default). */
  readStatus: 200 | 403;
  /** Error code of every 403 above (`EMAIL_UNVERIFIED` by default, like the server for unverified accounts). */
  forbiddenCode: "EMAIL_UNVERIFIED" | "FORBIDDEN";
}

/**
 * @param messageCount - How many messages the global room starts with.
 * @returns A fresh in-memory chat server.
 */
export function makeChatDb(messageCount = 5): ChatDb {
  const familia = Array.from({ length: messageCount }, (_, index) => makeMessage(index + 1));
  return {
    rooms: makeRooms(),
    messages: new Map([
      [ROOMS.familia, familia],
      [ROOMS.y2026, []],
      [ROOMS.y2025, []]
    ]),
    tickets: [],
    reads: [],
    deleted: [],
    historyRequests: [],
    ticketStatus: 201,
    readStatus: 200,
    forbiddenCode: "EMAIL_UNVERIFIED"
  };
}

/**
 * MSW handlers over a {@link ChatDb}. History pages are keyset-style: the
 * cursor is the index of the oldest message already returned.
 *
 * @param db - The in-memory server.
 * @returns The handlers.
 */
export function chatHandlers(db: ChatDb): HttpHandler[] {
  return [
    http.get(apiUrl("/chat/rooms"), () =>
      db.readStatus === 403 ? HttpResponse.json(errorBody(db.forbiddenCode, "Sin acceso."), { status: 403 }) : HttpResponse.json(db.rooms)
    ),
    http.get(apiUrl("/chat/rooms/:id/messages"), ({ params, request }) => {
      if (db.readStatus === 403) return HttpResponse.json(errorBody(db.forbiddenCode, "Sin acceso."), { status: 403 });
      const roomId = String(params.id);
      const all = db.messages.get(roomId);
      if (all === undefined) return HttpResponse.json(errorBody("NOT_FOUND", "No existe."), { status: 404 });
      const url = new URL(request.url);
      const before = url.searchParams.get("before");
      const limit = Number(url.searchParams.get("limit") ?? 50);
      db.historyRequests.push({ roomId, before, limit });
      const end = before === null ? all.length : Number(before.replace("c:", ""));
      const start = Math.max(0, end - limit);
      return HttpResponse.json({ messages: all.slice(start, end), nextBefore: start > 0 ? `c:${start}` : null });
    }),
    http.post(apiUrl("/chat/rooms/:id/read"), async ({ params, request }) => {
      const body = (await request.json()) as { messageId: string }; // Test-only: the client sends `markReadInputSchema`.
      db.reads.push({ roomId: String(params.id), messageId: body.messageId });
      return new HttpResponse(null, { status: 204 });
    }),
    http.post(apiUrl("/chat/ticket"), () => {
      if (db.ticketStatus === 403) return HttpResponse.json(errorBody(db.forbiddenCode, "Sin acceso."), { status: 403 });
      if (db.ticketStatus === 500) return HttpResponse.json(errorBody("INTERNAL", "Falla."), { status: 500 });
      const ticket = ticketValue(db.tickets.length + 1);
      db.tickets.push(ticket);
      return HttpResponse.json({ ticket, expiresAt: new Date(Date.now() + 30_000).toISOString(), wsPath: "/api/chat/ws" }, { status: 201 });
    }),
    http.delete(apiUrl("/chat/messages/:id"), ({ params }) => {
      db.deleted.push(String(params.id));
      return new HttpResponse(null, { status: 204 });
    })
  ];
}

/** Frame builders (server → client). */
export const frames = {
  message: (message: ChatMessage, clientMessageId: string | null = null): WsServerMessage => ({ type: "message", message, clientMessageId }),
  deleted: (roomId: string, messageId: string): WsServerMessage => ({ type: "message_deleted", roomId, messageId }),
  typing: (roomId: string, sender: ChatSender): WsServerMessage => ({ type: "typing", roomId, userId: sender.userId, displayName: sender.displayName }),
  error: (clientMessageId: string | null): WsServerMessage => ({ type: "error", code: "RATE_LIMITED", message: "Más despacio.", clientMessageId })
};
