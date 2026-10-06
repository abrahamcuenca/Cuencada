import { describe, expect, it } from "vitest";
import {
  CHAT_PREVIEW_MAX_LENGTH,
  CHAT_UNREAD_COUNT_MAX,
  chatHistoryQuerySchema,
  chatRoomSchema,
  wsClientMessageSchema,
  wsServerMessageSchema
} from "./chat.js";

const roomId = "6f1b2a3c-4d5e-4f60-8a7b-9c0d1e2f3a4b";
const messageId = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const userId = "1b2c3d4e-5f60-4b7c-9d8e-0f1a2b3c4d5e";

describe("wsClientMessageSchema", () => {
  it("parses each client frame type", () => {
    expect(wsClientMessageSchema.parse({ type: "send", roomId, body: " hola ", clientMessageId: messageId })).toEqual({
      type: "send",
      roomId,
      body: "hola",
      clientMessageId: messageId
    });
    expect(wsClientMessageSchema.parse({ type: "typing", roomId }).type).toBe("typing");
    expect(wsClientMessageSchema.parse({ type: "read", roomId, messageId }).type).toBe("read");
    expect(wsClientMessageSchema.parse({ type: "ping" })).toEqual({ type: "ping" });
  });

  it("rejects unknown frame types", () => {
    expect(wsClientMessageSchema.safeParse({ type: "message", roomId }).success).toBe(false);
    expect(wsClientMessageSchema.safeParse({ roomId }).success).toBe(false);
  });

  it("rejects empty and oversized bodies", () => {
    expect(wsClientMessageSchema.safeParse({ type: "send", roomId, body: "   ", clientMessageId: messageId }).success).toBe(false);
    expect(wsClientMessageSchema.safeParse({ type: "send", roomId, body: "a".repeat(2000), clientMessageId: messageId }).success).toBe(true);
    expect(wsClientMessageSchema.safeParse({ type: "send", roomId, body: "a".repeat(2001), clientMessageId: messageId }).success).toBe(false);
  });

  it("strips bidi controls and rejects invisible-only bodies", () => {
    const send = (body: string): unknown => ({ type: "send", roomId, body, clientMessageId: messageId });
    expect(wsClientMessageSchema.parse(send("hola\u202E mundo"))).toMatchObject({ body: "hola mundo" });
    expect(wsClientMessageSchema.safeParse(send("\u200B")).success).toBe(false);
    expect(wsClientMessageSchema.safeParse(send("\u200D\u200D")).success).toBe(false);
    expect(wsClientMessageSchema.parse(send("👨\u200D👩\u200D👧"))).toMatchObject({ body: "👨\u200D👩\u200D👧" });
  });

  it("requires a uuid clientMessageId", () => {
    expect(wsClientMessageSchema.safeParse({ type: "send", roomId, body: "x", clientMessageId: "abc" }).success).toBe(false);
  });

  it("strips unknown keys such as a spoofed sender", () => {
    const parsed = wsClientMessageSchema.parse({ type: "typing", roomId, userId });
    expect(parsed).toEqual({ type: "typing", roomId });
  });
});

describe("wsServerMessageSchema", () => {
  it("parses a message event", () => {
    const frame = {
      type: "message",
      clientMessageId: null,
      message: {
        id: messageId,
        roomId,
        sender: { userId, displayName: "Abraham", avatarUrl: null },
        body: "hola",
        createdAt: "2026-09-13T19:30:00Z",
        deletedAt: null
      }
    };
    expect(wsServerMessageSchema.parse(frame).type).toBe("message");
  });

  it("parses deleted, typing, presence, error and pong frames", () => {
    expect(wsServerMessageSchema.parse({ type: "message_deleted", roomId, messageId }).type).toBe("message_deleted");
    expect(wsServerMessageSchema.parse({ type: "typing", roomId, userId, displayName: "Ana" }).type).toBe("typing");
    expect(wsServerMessageSchema.parse({ type: "presence", onlineUserIds: [userId] }).type).toBe("presence");
    expect(wsServerMessageSchema.parse({ type: "error", code: "RATE_LIMITED", message: "Más despacio.", clientMessageId: null }).type).toBe("error");
    expect(wsServerMessageSchema.parse({ type: "pong", ts: 1 }).type).toBe("pong");
  });

  it("requires the echoed clientMessageId to be a uuid or null", () => {
    expect(wsServerMessageSchema.safeParse({ type: "error", code: "VALIDATION", message: "x", clientMessageId: messageId }).success).toBe(true);
    expect(wsServerMessageSchema.safeParse({ type: "error", code: "VALIDATION", message: "x", clientMessageId: "abc" }).success).toBe(false);
  });

  it("rejects error frames with unknown codes", () => {
    expect(wsServerMessageSchema.safeParse({ type: "error", code: "NOPE", message: "x", clientMessageId: null }).success).toBe(false);
  });
});

describe("chatHistoryQuerySchema", () => {
  it("defaults to 50 and caps the limit at 50", () => {
    expect(chatHistoryQuerySchema.parse({})).toEqual({ limit: 50 });
    expect(chatHistoryQuerySchema.parse({ limit: "50" }).limit).toBe(50);
    expect(chatHistoryQuerySchema.safeParse({ limit: "51" }).success).toBe(false);
  });
});

describe("chatRoomSchema", () => {
  it("carries a bounded last-message preview and unread count", () => {
    const lastMessage = { id: messageId, senderDisplayName: "Ana", preview: "hola", createdAt: "2026-09-13T19:30:00.000Z" };
    const room = {
      id: roomId,
      kind: "global",
      cuencadaId: null,
      year: null,
      title: "Chat familiar",
      unreadCount: 3,
      lastMessageAt: "2026-09-13T19:30:00.000Z",
      lastReadMessageId: null,
      lastMessage
    };
    expect(chatRoomSchema.parse(room).lastMessage?.preview).toBe("hola");
    const tooLong = { ...room, lastMessage: { ...lastMessage, preview: "x".repeat(CHAT_PREVIEW_MAX_LENGTH + 1) } };
    expect(chatRoomSchema.safeParse(tooLong).success).toBe(false);
    expect(chatRoomSchema.safeParse({ ...room, unreadCount: CHAT_UNREAD_COUNT_MAX + 1 }).success).toBe(false);
  });
});
