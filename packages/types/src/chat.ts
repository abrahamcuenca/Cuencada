/**
 * Chat: REST for rooms/history/tickets plus a WebSocket protocol.
 *
 * WebSocket handshake: `POST /api/chat/ticket` → connect to
 * `wss://<host>/api/chat/ws?ticket=<ticket>`. The ticket is single-use,
 * expires in 30s, is bound to the issuing session (revoking the session
 * invalidates unused tickets), and must be redacted from app *and* reverse-proxy
 * logs. The server checks `Origin` on upgrade and closes sockets whose session
 * is revoked.
 *
 * Rooms: the global room is created by the seed; a Cuencada room is created
 * automatically the first time that Cuencada is published.
 * Every frame is JSON, validated with the discriminated unions below.
 */
import { z } from "zod";
import {
  cursorSchema,
  dateTimeSchema,
  errorCodeSchema,
  hasVisibleChars,
  idSchema,
  opaqueTokenSchema,
  stripUnsafeChars
} from "./common.js";

export const ChatRoomKind = {
  Global: "global",
  Cuencada: "cuencada"
} as const;
export type ChatRoomKind = (typeof ChatRoomKind)[keyof typeof ChatRoomKind];
export const chatRoomKindSchema = z.enum(ChatRoomKind);

export const CHAT_BODY_MAX_LENGTH = 2000;
/** Hard cap on an inbound WS frame, enforced before JSON.parse. */
export const WS_MAX_FRAME_BYTES = 16 * 1024;
/** Server ping/keepalive interval. */
export const WS_PING_INTERVAL_MS = 25_000;

/** Application close codes (4000–4999 range). */
export const WsCloseCode = {
  Unauthenticated: 4001,
  Forbidden: 4003,
  RateLimited: 4008,
  SessionRevoked: 4010,
  ProtocolError: 4400
} as const;
export type WsCloseCode = (typeof WsCloseCode)[keyof typeof WsCloseCode];

/* -------------------------------------------------------------------------- */
/* REST models                                                                 */
/* -------------------------------------------------------------------------- */

/** A room the caller can read (`GET /api/chat/rooms`). */
export interface ChatRoom {
  id: string;
  kind: ChatRoomKind;
  cuencadaId: string | null;
  year: number | null;
  title: string;
  unreadCount: number;
  lastMessageAt: string | null;
  lastReadMessageId: string | null;
}

export const chatRoomSchema = z.object({
  id: idSchema,
  kind: chatRoomKindSchema,
  cuencadaId: idSchema.nullable(),
  year: z.number().int().nullable(),
  title: z.string().max(200),
  unreadCount: z.number().int().min(0),
  lastMessageAt: dateTimeSchema.nullable(),
  lastReadMessageId: idSchema.nullable()
}) satisfies z.ZodType<ChatRoom>;

export interface ChatSender {
  userId: string;
  displayName: string;
  avatarUrl: string | null;
}

export const chatSenderSchema = z.object({
  userId: idSchema,
  displayName: z.string().max(80),
  avatarUrl: z.string().max(4096).nullable()
}) satisfies z.ZodType<ChatSender>;

/** A message. Deleted messages keep their slot with `body: ""` and `deletedAt` set. */
export interface ChatMessage {
  id: string;
  roomId: string;
  /** `null` if the sender's account was removed. */
  sender: ChatSender | null;
  body: string;
  createdAt: string;
  deletedAt: string | null;
}

export const chatMessageSchema = z.object({
  id: idSchema,
  roomId: idSchema,
  sender: chatSenderSchema.nullable(),
  body: z.string().max(CHAT_BODY_MAX_LENGTH),
  createdAt: dateTimeSchema,
  deletedAt: dateTimeSchema.nullable()
}) satisfies z.ZodType<ChatMessage>;

/**
 * Outgoing message body: NFC, bidi controls and invisible marks stripped
 * (ZWJ kept for emoji), trimmed, 1–2000 chars, at least one visible character.
 */
export const chatBodySchema = z
  .string()
  .max(CHAT_BODY_MAX_LENGTH * 2, { error: `Máximo ${CHAT_BODY_MAX_LENGTH} caracteres.` })
  .transform((value) => stripUnsafeChars(value.normalize("NFC")).trim())
  .pipe(
    z
      .string()
      .min(1, { error: "El mensaje está vacío." })
      .max(CHAT_BODY_MAX_LENGTH, { error: `Máximo ${CHAT_BODY_MAX_LENGTH} caracteres.` })
      .refine(hasVisibleChars, { error: "El mensaje está vacío." })
  );

/** `:id` path parameter of `/api/chat/rooms/:id/…`. */
export const roomIdParamSchema = z.object({ id: idSchema });
export type RoomIdParam = z.infer<typeof roomIdParamSchema>;

/** `GET /api/chat/rooms/:id/messages` query (keyset, newest pages first). Params: `roomIdParamSchema`. */
export const chatHistoryQuerySchema = z.object({
  /** Opaque cursor from a previous page's `nextBefore`. Omit for the latest page. */
  before: cursorSchema.exactOptional(),
  limit: z.coerce.number<number | string>().int().min(1).max(100).default(50)
});
export type ChatHistoryQuery = z.infer<typeof chatHistoryQuerySchema>;
export type ChatHistoryQueryRequest = z.input<typeof chatHistoryQuerySchema>;

/** One history page. `messages` are oldest → newest within the page. */
export interface ChatHistoryPage {
  messages: ChatMessage[];
  /** Cursor for older messages, `null` at the beginning of the room. */
  nextBefore: string | null;
}

export const chatHistoryPageSchema = z.object({
  messages: z.array(chatMessageSchema),
  nextBefore: z.string().nullable()
}) satisfies z.ZodType<ChatHistoryPage>;

/** `POST /api/chat/rooms/:id/read` body. Params: `roomIdParamSchema`. */
export const markReadInputSchema = z.object({ messageId: idSchema });
export type MarkReadInput = z.infer<typeof markReadInputSchema>;
export type MarkReadRequest = z.input<typeof markReadInputSchema>;

/** `POST /api/chat/ticket` response. */
export interface ChatTicketResponse {
  ticket: string;
  expiresAt: string;
  /** Path to open with `?ticket=`, e.g. `/api/chat/ws`. */
  wsPath: string;
}

export const chatTicketResponseSchema = z.object({
  ticket: z.string().max(256),
  expiresAt: dateTimeSchema,
  wsPath: z.string().max(100)
}) satisfies z.ZodType<ChatTicketResponse>;

/** WS connect query. */
export const chatWsQuerySchema = z.object({
  ticket: opaqueTokenSchema
});
export type ChatWsQuery = z.infer<typeof chatWsQuerySchema>;
export type ChatWsQueryRequest = z.input<typeof chatWsQuerySchema>;

/* -------------------------------------------------------------------------- */
/* WebSocket: client → server                                                  */
/* -------------------------------------------------------------------------- */

/** Client-generated id used to match the echo/ack and dedupe retries. */
const clientMessageIdSchema = idSchema;

export const wsClientSendSchema = z.object({
  type: z.literal("send"),
  roomId: idSchema,
  body: chatBodySchema,
  clientMessageId: clientMessageIdSchema
});
export const wsClientTypingSchema = z.object({
  type: z.literal("typing"),
  roomId: idSchema
});
export const wsClientReadSchema = z.object({
  type: z.literal("read"),
  roomId: idSchema,
  messageId: idSchema
});
export const wsClientPingSchema = z.object({
  type: z.literal("ping"),
  ts: z.number().int().nonnegative().exactOptional()
});

/** Any frame the browser may send. Unknown `type` → `error` frame `VALIDATION`. */
export const wsClientMessageSchema = z.discriminatedUnion("type", [
  wsClientSendSchema,
  wsClientTypingSchema,
  wsClientReadSchema,
  wsClientPingSchema
]);
export type WsClientMessage = z.infer<typeof wsClientMessageSchema>;
export type WsClientMessageRequest = z.input<typeof wsClientMessageSchema>;

/* -------------------------------------------------------------------------- */
/* WebSocket: server → client                                                  */
/* -------------------------------------------------------------------------- */

export const wsServerMessageEventSchema = z.object({
  type: z.literal("message"),
  message: chatMessageSchema,
  /** Echo of the sender's `clientMessageId`; `null` for other recipients. */
  clientMessageId: clientMessageIdSchema.nullable()
});
export const wsServerMessageDeletedSchema = z.object({
  type: z.literal("message_deleted"),
  roomId: idSchema,
  messageId: idSchema
});
export const wsServerTypingSchema = z.object({
  type: z.literal("typing"),
  roomId: idSchema,
  userId: idSchema,
  displayName: z.string().max(80)
});
export const wsServerPresenceSchema = z.object({
  type: z.literal("presence"),
  onlineUserIds: z.array(idSchema).max(5000)
});
export const wsServerErrorSchema = z.object({
  type: z.literal("error"),
  code: errorCodeSchema,
  message: z.string().max(500),
  clientMessageId: clientMessageIdSchema.nullable()
});
export const wsServerPongSchema = z.object({
  type: z.literal("pong"),
  ts: z.number().int().nullable()
});

/** Any frame the server may send. */
export const wsServerMessageSchema = z.discriminatedUnion("type", [
  wsServerMessageEventSchema,
  wsServerMessageDeletedSchema,
  wsServerTypingSchema,
  wsServerPresenceSchema,
  wsServerErrorSchema,
  wsServerPongSchema
]);
export type WsServerMessage = z.infer<typeof wsServerMessageSchema>;
