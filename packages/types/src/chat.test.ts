import { describe, expect, it } from "vitest";
import { wsClientMessageSchema, wsServerMessageSchema } from "./chat.js";

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

  it("rejects error frames with unknown codes", () => {
    expect(wsServerMessageSchema.safeParse({ type: "error", code: "NOPE", message: "x", clientMessageId: null }).success).toBe(false);
  });
});
