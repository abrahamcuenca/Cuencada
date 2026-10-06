import { randomUUID } from "node:crypto";
import { CHAT_TICKET_TTL_SECONDS, chatHistoryPageSchema, chatRoomSchema } from "@cuencada/types";
import { and, eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { App } from "../../app.js";
import { auditLogs, chatMessages, chatReadStates, profiles } from "../../db/schema/index.js";
import { createTestApp } from "../../../test/helpers/app.js";
import {
  type ChatMember,
  createChatMember,
  insertEditionRoom,
  insertGlobalRoom,
  insertMessage
} from "../../../test/helpers/chat.js";
import { getTestDb } from "../../../test/helpers/db.js";
import { createCuencada } from "../../../test/helpers/media.js";

const roomsSchema = z.array(chatRoomSchema);
let app: App | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function start(): Promise<App> {
  app = await createTestApp();
  return app;
}

function at(seconds: number): Date {
  return new Date(Date.UTC(2026, 8, 1, 12, 0, seconds));
}

async function getRooms(server: App, member: ChatMember) {
  const response = await server.inject({
    method: "GET",
    url: "/api/chat/rooms",
    ...member.auth
  });
  expect(response.statusCode).toBe(200);
  return roomsSchema.parse(response.json());
}

describe("GET /api/chat/rooms", () => {
  it("lists the global room and published edition rooms with unread counts and previews, newest activity first", async () => {
    const server = await start();
    const me = await createChatMember({ displayName: "Ana" });
    const other = await createChatMember({ displayName: "Beto" });
    const global = await insertGlobalRoom();
    const published = await createCuencada({ year: 2026 });
    const draft = await createCuencada({ year: 2027, isPublished: false });
    const editionRoom = await insertEditionRoom(published.id, 2026);
    const hiddenRoom = await insertEditionRoom(draft.id, 2027);

    const first = await insertMessage({
      roomId: global.id,
      senderUserId: other.user.id,
      createdAt: at(1)
    });
    await insertMessage({
      roomId: global.id,
      senderUserId: other.user.id,
      createdAt: at(2)
    });
    await insertMessage({
      roomId: global.id,
      senderUserId: me.user.id,
      createdAt: at(3),
      body: "mío"
    });
    await insertMessage({
      roomId: global.id,
      senderUserId: other.user.id,
      createdAt: at(4),
      deletedAt: at(5)
    });
    await insertMessage({
      roomId: editionRoom.id,
      senderUserId: other.user.id,
      createdAt: at(10),
      body: `  hola\n\n${"x".repeat(300)}`
    });
    await insertMessage({
      roomId: hiddenRoom.id,
      senderUserId: other.user.id,
      createdAt: at(20)
    });
    await getTestDb().insert(chatReadStates).values({
      roomId: global.id,
      userId: me.user.id,
      lastReadMessageId: first.id
    });

    const rooms = await getRooms(server, me);
    expect(rooms.map((room) => room.id)).toEqual([editionRoom.id, global.id]);
    const [edition, globalRoom] = rooms;
    // Edition: one message from someone else, never read.
    expect(edition).toMatchObject({
      kind: "cuencada",
      year: 2026,
      title: "Cuencada 2026",
      unreadCount: 1,
      lastReadMessageId: null
    });
    expect(edition?.lastMessage?.preview.startsWith("hola x")).toBe(true);
    expect(edition?.lastMessage?.preview.endsWith("…")).toBe(true);
    expect(edition?.lastMessage?.preview.length).toBeLessThanOrEqual(140);
    // Global: after `first`, one live message from Beto (own and deleted ones do not count).
    expect(globalRoom).toMatchObject({
      kind: "global",
      cuencadaId: null,
      unreadCount: 1,
      lastReadMessageId: first.id
    });
    expect(globalRoom?.lastMessage).toMatchObject({
      preview: "mío",
      senderDisplayName: "Ana"
    });
    expect(globalRoom?.lastMessageAt).toBe(at(3).toISOString());
  });

  it("answers 401 without a token", async () => {
    const server = await start();
    const response = await server.inject({
      method: "GET",
      url: "/api/chat/rooms"
    });
    expect(response.statusCode).toBe(401);
  });

  it("answers 403 to a member whose email is not verified", async () => {
    const server = await start();
    const unverified = await createChatMember({ emailVerified: false });
    for (const [method, url] of [
      ["GET", "/api/chat/rooms"],
      ["GET", `/api/chat/rooms/${randomUUID()}/messages`],
      ["POST", "/api/chat/ticket"],
      ["DELETE", `/api/chat/messages/${randomUUID()}`]
    ] as const) {
      const response = await server.inject({ method, url, ...unverified.auth });
      expect(response.statusCode, `${method} ${url}`).toBe(403);
    }
  });
});

describe("GET /api/chat/rooms/:id/messages", () => {
  it("pages with a keyset cursor, oldest → newest within a page, ties broken by id", async () => {
    const server = await start();
    const me = await createChatMember();
    const room = await insertGlobalRoom();
    const inserted = [];
    // 7 messages; three share one timestamp so the id tie-breaker matters.
    for (const seconds of [1, 2, 3, 3, 3, 4, 5]) {
      inserted.push(
        await insertMessage({
          roomId: room.id,
          senderUserId: me.user.id,
          createdAt: at(seconds)
        })
      );
    }
    const expected = [...inserted]
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : 1))
      .map((row) => row.id);

    const seen: string[][] = [];
    let before: string | null = null;
    do {
      const query: string = before === null ? "limit=3" : `limit=3&before=${before}`;
      const response = await server.inject({
        method: "GET",
        url: `/api/chat/rooms/${room.id}/messages?${query}`,
        ...me.auth
      });
      expect(response.statusCode).toBe(200);
      const page = chatHistoryPageSchema.parse(response.json());
      seen.unshift(page.messages.map((message) => message.id));
      before = page.nextBefore;
    } while (before !== null);

    expect(seen.map((page) => page.length)).toEqual([1, 3, 3]);
    expect(seen.flat()).toEqual(expected);
  });

  it("returns deleted messages as tombstones and presigns sender avatars", async () => {
    const server = await start();
    const me = await createChatMember({ displayName: "Ana" });
    const avatarKey = `avatars/${me.user.id}/${randomUUID()}-256.webp`;
    await getTestDb().update(profiles).set({ avatarKey }).where(eq(profiles.userId, me.user.id));
    const room = await insertGlobalRoom();
    await insertMessage({
      roomId: room.id,
      senderUserId: me.user.id,
      createdAt: at(1),
      body: "secreto",
      deletedAt: at(2)
    });
    await insertMessage({
      roomId: room.id,
      senderUserId: null,
      createdAt: at(3),
      body: "huérfano"
    });

    const response = await server.inject({
      method: "GET",
      url: `/api/chat/rooms/${room.id}/messages`,
      ...me.auth
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain("secreto");
    const page = chatHistoryPageSchema.parse(response.json());
    expect(page.nextBefore).toBeNull();
    const [tombstone, orphan] = page.messages;
    expect(tombstone).toMatchObject({
      body: "",
      deletedAt: at(2).toISOString()
    });
    expect(tombstone?.sender?.displayName).toBe("Ana");
    expect(tombstone?.sender?.avatarUrl).toContain(encodeURIComponent(me.user.id));
    expect(tombstone?.sender?.avatarUrl).toContain("-64.webp");
    expect(orphan).toMatchObject({ body: "huérfano", sender: null });
  });

  it("answers 404 for unknown rooms and rooms of unpublished editions", async () => {
    const server = await start();
    const me = await createChatMember();
    const draft = await createCuencada({ year: 2030, isPublished: false });
    const hidden = await insertEditionRoom(draft.id, 2030);
    for (const id of [randomUUID(), hidden.id]) {
      const response = await server.inject({
        method: "GET",
        url: `/api/chat/rooms/${id}/messages`,
        ...me.auth
      });
      expect(response.statusCode).toBe(404);
    }
  });

  it("answers 400 for a limit over 50, a forged cursor or a bad room id", async () => {
    const server = await start();
    const me = await createChatMember();
    const room = await insertGlobalRoom();
    const forged = Buffer.from(`c1:99999999999999999999:${randomUUID()}`).toString("base64url");
    for (const url of [
      `/api/chat/rooms/${room.id}/messages?limit=51`,
      `/api/chat/rooms/${room.id}/messages?before=${forged}`,
      `/api/chat/rooms/${room.id}/messages?before=bm9wZQ`,
      "/api/chat/rooms/nope/messages"
    ]) {
      const response = await server.inject({ method: "GET", url, ...me.auth });
      expect(response.statusCode, url).toBe(400);
    }
  });
});

describe("POST /api/chat/rooms/:id/read", () => {
  it("moves the read marker forward only and updates the unread count", async () => {
    const server = await start();
    const me = await createChatMember();
    const other = await createChatMember();
    const room = await insertGlobalRoom();
    const older = await insertMessage({
      roomId: room.id,
      senderUserId: other.user.id,
      createdAt: at(1)
    });
    const newer = await insertMessage({
      roomId: room.id,
      senderUserId: other.user.id,
      createdAt: at(2)
    });
    await insertMessage({
      roomId: room.id,
      senderUserId: other.user.id,
      createdAt: at(3)
    });

    const read = (messageId: string) =>
      server.inject({
        method: "POST",
        url: `/api/chat/rooms/${room.id}/read`,
        payload: { messageId },
        ...me.auth
      });

    expect((await read(newer.id)).statusCode).toBe(204);
    expect((await getRooms(server, me))[0]?.unreadCount).toBe(1);
    expect((await read(older.id)).statusCode).toBe(204);
    const [state] = await getTestDb()
      .select()
      .from(chatReadStates)
      .where(and(eq(chatReadStates.roomId, room.id), eq(chatReadStates.userId, me.user.id)));
    expect(state?.lastReadMessageId).toBe(newer.id);
    expect((await getRooms(server, me))[0]).toMatchObject({
      unreadCount: 1,
      lastReadMessageId: newer.id
    });
  });

  it("answers 404 for a message of another room and 400 for a bad body", async () => {
    const server = await start();
    const me = await createChatMember();
    const room = await insertGlobalRoom();
    const edition = await insertEditionRoom((await createCuencada()).id, 2026);
    const elsewhere = await insertMessage({
      roomId: edition.id,
      senderUserId: me.user.id
    });
    const wrongRoom = await server.inject({
      method: "POST",
      url: `/api/chat/rooms/${room.id}/read`,
      payload: { messageId: elsewhere.id },
      ...me.auth
    });
    expect(wrongRoom.statusCode).toBe(404);
    const bad = await server.inject({
      method: "POST",
      url: `/api/chat/rooms/${room.id}/read`,
      payload: {},
      ...me.auth
    });
    expect(bad.statusCode).toBe(400);
  });
});

describe("DELETE /api/chat/messages/:id", () => {
  it("lets the sender soft-delete their message without an audit entry", async () => {
    const server = await start();
    const me = await createChatMember();
    const room = await insertGlobalRoom();
    const message = await insertMessage({
      roomId: room.id,
      senderUserId: me.user.id
    });
    const response = await server.inject({
      method: "DELETE",
      url: `/api/chat/messages/${message.id}`,
      ...me.auth
    });
    expect(response.statusCode).toBe(204);
    const [row] = await getTestDb().select().from(chatMessages).where(eq(chatMessages.id, message.id));
    expect(row?.deletedAt).not.toBeNull();
    expect(row?.deletedByUserId).toBe(me.user.id);
    expect(await getTestDb().select().from(auditLogs)).toHaveLength(0);
    // Again: a no-op 204.
    const again = await server.inject({
      method: "DELETE",
      url: `/api/chat/messages/${message.id}`,
      ...me.auth
    });
    expect(again.statusCode).toBe(204);
  });

  it("answers 404 (not 403) for another member's message", async () => {
    const server = await start();
    const me = await createChatMember();
    const other = await createChatMember();
    const room = await insertGlobalRoom();
    const message = await insertMessage({
      roomId: room.id,
      senderUserId: other.user.id
    });
    const response = await server.inject({
      method: "DELETE",
      url: `/api/chat/messages/${message.id}`,
      ...me.auth
    });
    expect(response.statusCode).toBe(404);
    const [row] = await getTestDb().select().from(chatMessages).where(eq(chatMessages.id, message.id));
    expect(row?.deletedAt).toBeNull();
  });

  it("answers 404 for messages in rooms of unpublished editions, even to the sender and admins", async () => {
    const server = await start();
    const me = await createChatMember();
    const admin = await createChatMember({ role: "admin" });
    const draft = await createCuencada({ year: 2032, isPublished: false });
    const hidden = await insertEditionRoom(draft.id, 2032);
    const message = await insertMessage({ roomId: hidden.id, senderUserId: me.user.id });
    for (const auth of [me.auth, admin.auth]) {
      const response = await server.inject({ method: "DELETE", url: `/api/chat/messages/${message.id}`, ...auth });
      expect(response.statusCode).toBe(404);
    }
    const [row] = await getTestDb().select().from(chatMessages).where(eq(chatMessages.id, message.id));
    expect(row?.deletedAt).toBeNull();
  });

  it("lets an admin delete anyone's message and audits it without the body", async () => {
    const server = await start();
    const admin = await createChatMember({ role: "admin" });
    const other = await createChatMember();
    const room = await insertGlobalRoom();
    const message = await insertMessage({
      roomId: room.id,
      senderUserId: other.user.id,
      body: "ofensivo"
    });
    const response = await server.inject({
      method: "DELETE",
      url: `/api/chat/messages/${message.id}`,
      ...admin.auth
    });
    expect(response.statusCode).toBe(204);
    const audits = await getTestDb().select().from(auditLogs);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actorUserId: admin.user.id,
      action: "chat_message.deleted",
      entityType: "chat_message",
      entityId: message.id,
      metadata: { roomId: room.id, senderUserId: other.user.id }
    });
    expect(JSON.stringify(audits)).not.toContain("ofensivo");
  });

  it("answers 404 for an unknown message and 400 for a bad id", async () => {
    const server = await start();
    const me = await createChatMember();
    expect(
      (
        await server.inject({
          method: "DELETE",
          url: `/api/chat/messages/${randomUUID()}`,
          ...me.auth
        })
      ).statusCode
    ).toBe(404);
    expect(
      (
        await server.inject({
          method: "DELETE",
          url: "/api/chat/messages/x",
          ...me.auth
        })
      ).statusCode
    ).toBe(400);
  });

  it("has no route that deletes a room", async () => {
    const server = await start();
    const admin = await createChatMember({ role: "admin" });
    const room = await insertEditionRoom((await createCuencada()).id, 2026);
    for (const url of [`/api/chat/rooms/${room.id}`, `/api/admin/chat/rooms/${room.id}`]) {
      const response = await server.inject({
        method: "DELETE",
        url,
        ...admin.auth
      });
      expect(response.statusCode, url).toBe(404);
    }
  });
});

describe("POST /api/chat/ticket", () => {
  it("issues a 30-second opaque ticket that is not cached", async () => {
    const server = await start();
    const me = await createChatMember();
    const response = await server.inject({
      method: "POST",
      url: "/api/chat/ticket",
      ...me.auth
    });
    expect(response.statusCode).toBe(201);
    expect(response.headers["cache-control"]).toBe("no-store");
    const body = response.json<{
      ticket: string;
      expiresAt: string;
      wsPath: string;
    }>();
    expect(body.ticket).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(body.wsPath).toBe("/api/chat/ws");
    const ttl = (Date.parse(body.expiresAt) - Date.now()) / 1000;
    expect(ttl).toBeGreaterThan(CHAT_TICKET_TTL_SECONDS - 5);
    expect(ttl).toBeLessThanOrEqual(CHAT_TICKET_TTL_SECONDS);
  });

  it("limits each user to 10 tickets per minute", async () => {
    const server = await start();
    const me = await createChatMember();
    const other = await createChatMember();
    for (let i = 0; i < 10; i += 1) {
      expect(
        (
          await server.inject({
            method: "POST",
            url: "/api/chat/ticket",
            ...me.auth
          })
        ).statusCode
      ).toBe(201);
    }
    const limited = await server.inject({
      method: "POST",
      url: "/api/chat/ticket",
      ...me.auth
    });
    expect(limited.statusCode).toBe(429);
    expect(
      (
        await server.inject({
          method: "POST",
          url: "/api/chat/ticket",
          ...other.auth
        })
      ).statusCode
    ).toBe(201);
  });

  it("answers 401 without a token", async () => {
    const server = await start();
    expect((await server.inject({ method: "POST", url: "/api/chat/ticket" })).statusCode).toBe(401);
  });
});
