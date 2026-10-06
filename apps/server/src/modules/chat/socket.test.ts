import { randomUUID } from "node:crypto";
import { CHAT_TICKET_TTL_SECONDS, WS_MAX_FRAME_BYTES, WsCloseCode } from "@cuencada/types";
import { and, eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import type { App } from "../../app.js";
import { chatMessages, chatReadStates, sessions, users } from "../../db/schema/index.js";
import { createTestApp } from "../../../test/helpers/app.js";
import { TestClock } from "../../../test/helpers/auth.js";
import {
  type ChatMember,
  type ChatTestClient,
  connectChat,
  connectMember,
  createChatMember,
  frameOf,
  insertEditionRoom,
  insertGlobalRoom,
  insertMessage,
  issueTicket,
  sleep
} from "../../../test/helpers/chat.js";
import { getTestDb } from "../../../test/helpers/db.js";
import { bearerFor, createSession } from "../../../test/helpers/factories.js";
import { createCuencada } from "../../../test/helpers/media.js";
import { chatHubOf, closeSocketsForSession, closeSocketsForUser } from "./index.js";
import { MAX_BAD_FRAMES, WS_POLICY_VIOLATION } from "./socket.js";

let app: App | undefined;
const clients: ChatTestClient[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.ws.terminate();
  await app?.close();
  app = undefined;
});

async function start(options: { clock?: TestClock; logs?: string[] } = {}): Promise<App> {
  const logs = options.logs;
  app = await createTestApp({
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    ...(logs === undefined ? {} : { logStream: { write: (line: string) => logs.push(line) } })
  });
  return app;
}

async function join(server: App, member: ChatMember): Promise<ChatTestClient> {
  const client = await connectMember(server, member);
  clients.push(client);
  return client;
}

async function open(server: App, options: Parameters<typeof connectChat>[1]): Promise<ChatTestClient> {
  const client = await connectChat(server, options);
  clients.push(client);
  return client;
}

function hub(server: App) {
  const found = chatHubOf(server);
  if (found === null) throw new Error("no chat hub");
  return found;
}

function sendFrame(roomId: string, body: string, clientMessageId: string = randomUUID()) {
  return { type: "send", roomId, body, clientMessageId };
}

describe("chat WebSocket handshake", () => {
  it("closes with 1008 for a disallowed or missing Origin and burns the ticket", async () => {
    const server = await start();
    const me = await createChatMember();
    for (const origin of ["https://evil.example", null]) {
      const { ticket } = await issueTicket(server, me);
      const client = await open(server, { ticket, origin });
      expect((await client.closed).code).toBe(WS_POLICY_VIOLATION);
      // The attempt burned it: the real origin cannot use it afterwards.
      const retry = await open(server, { ticket });
      expect((await retry.closed).code).toBe(WS_POLICY_VIOLATION);
    }
    expect(hub(server).tickets.size).toBe(0);
  });

  it("burns a ticket on first use", async () => {
    const server = await start();
    const me = await createChatMember();
    const { ticket } = await issueTicket(server, me);
    const first = await open(server, { ticket });
    await first.waitFor(frameOf("presence"));
    const replay = await open(server, { ticket });
    expect((await replay.closed).code).toBe(WS_POLICY_VIOLATION);
    expect(hub(server).tickets.size).toBe(0);
  });

  it("rejects missing, unknown and expired tickets", async () => {
    const clock = new TestClock();
    const server = await start({ clock });
    const me = await createChatMember();
    const { ticket } = await issueTicket(server, me);
    clock.advance(CHAT_TICKET_TTL_SECONDS * 1000 + 1);
    for (const options of [{}, { ticket: "A".repeat(43) }, { ticket }]) {
      const client = await open(server, options);
      expect((await client.closed).code).toBe(WS_POLICY_VIOLATION);
    }
  });

  it("binds the ticket to its session: revoking the session invalidates it", async () => {
    const server = await start();
    const me = await createChatMember();
    const { ticket } = await issueTicket(server, me);
    await getTestDb()
      .update(sessions)
      .set({ revokedAt: new Date(), revokedReason: "logout" })
      .where(eq(sessions.id, me.sessionId));
    const client = await open(server, { ticket });
    expect((await client.closed).code).toBe(WS_POLICY_VIOLATION);
  });

  it("rejects disabled and unverified users holding a ticket", async () => {
    const server = await start();
    for (const change of [{ status: "disabled" as const }, { emailVerifiedAt: null }, { mustChangePassword: true }]) {
      const me = await createChatMember();
      const { ticket } = await issueTicket(server, me);
      await getTestDb().update(users).set(change).where(eq(users.id, me.user.id));
      const client = await open(server, { ticket });
      expect((await client.closed).code, JSON.stringify(change)).toBe(WS_POLICY_VIOLATION);
    }
  });
});

describe("chat WebSocket frames", () => {
  it("fans a message out to every client and echoes clientMessageId to the sender only", async () => {
    const server = await start();
    const ana = await createChatMember({ displayName: "Ana" });
    const beto = await createChatMember({ displayName: "Beto" });
    const room = await insertGlobalRoom();
    const a = await join(server, ana);
    const b = await join(server, beto);
    const clientMessageId = randomUUID();

    a.send(sendFrame(room.id, "  ¡Hola‮ familia!  ", clientMessageId));

    const echo = await a.waitFor(frameOf("message"));
    const received = await b.waitFor(frameOf("message"));
    expect(echo.clientMessageId).toBe(clientMessageId);
    expect(received.clientMessageId).toBeNull();
    expect(received.message).toEqual(echo.message);
    expect(echo.message).toMatchObject({
      roomId: room.id,
      body: "¡Hola familia!",
      deletedAt: null
    });
    expect(echo.message.sender).toMatchObject({
      userId: ana.user.id,
      displayName: "Ana"
    });
    const rows = await getTestDb().select().from(chatMessages);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      senderUserId: ana.user.id,
      clientMessageId,
      body: "¡Hola familia!"
    });
  });

  it("is idempotent on clientMessageId: a retry returns the stored message and is not re-broadcast", async () => {
    const server = await start();
    const ana = await createChatMember();
    const beto = await createChatMember();
    const room = await insertGlobalRoom();
    const a = await join(server, ana);
    const b = await join(server, beto);
    const clientMessageId = randomUUID();

    a.send(sendFrame(room.id, "una vez", clientMessageId));
    a.send(sendFrame(room.id, "una vez", clientMessageId));
    a.send({ type: "ping", ts: 1 });
    await a.waitFor(frameOf("pong"));

    const echoes = a.ofType("message");
    expect(echoes).toHaveLength(2);
    expect(echoes[1]?.message.id).toBe(echoes[0]?.message.id);
    expect(echoes.every((frame) => frame.clientMessageId === clientMessageId)).toBe(true);
    await sleep(50);
    expect(b.ofType("message")).toHaveLength(1);
    expect(await getTestDb().select().from(chatMessages)).toHaveLength(1);
  });

  it("answers invalid frames with error frames and closes after too many", async () => {
    const server = await start();
    const me = await createChatMember();
    const room = await insertGlobalRoom();
    const client = await join(server, me);
    const clientMessageId = randomUUID();

    client.send("{no es json");
    await client.waitFor(frameOf("error", (frame) => frame.message === "Mensaje mal formado."));
    client.send({
      type: "send",
      roomId: room.id,
      body: "   ",
      clientMessageId
    });
    const empty = await client.waitFor(frameOf("error", (frame) => frame.clientMessageId === clientMessageId));
    expect(empty).toMatchObject({
      code: "VALIDATION",
      message: "El mensaje está vacío."
    });
    client.ws.send(Buffer.from([1, 2, 3]), { binary: true });
    client.send({ type: "subscribe", roomId: room.id });
    await client.waitFor(frameOf("error", () => client.ofType("error").length === MAX_BAD_FRAMES - 1));
    expect(client.ofType("error").every((frame) => frame.code === "VALIDATION")).toBe(true);

    client.send({ type: "send", roomId: "nope" });
    expect((await client.closed).code).toBe(WsCloseCode.ProtocolError);
    expect(await getTestDb().select().from(chatMessages)).toHaveLength(0);
  });

  it("closes the socket on a frame over WS_MAX_FRAME_BYTES", async () => {
    const server = await start();
    const me = await createChatMember();
    const room = await insertGlobalRoom();
    const client = await join(server, me);
    client.send(sendFrame(room.id, "a".repeat(WS_MAX_FRAME_BYTES)));
    expect((await client.closed).code).toBe(1009);
  });

  it("rejects sends to unknown or hidden rooms", async () => {
    const server = await start();
    const me = await createChatMember();
    const draft = await createCuencada({ year: 2031, isPublished: false });
    const hidden = await insertEditionRoom(draft.id, 2031);
    const client = await join(server, me);
    for (const roomId of [randomUUID(), hidden.id]) {
      const clientMessageId = randomUUID();
      client.send(sendFrame(roomId, "hola", clientMessageId));
      const error = await client.waitFor(frameOf("error", (frame) => frame.clientMessageId === clientMessageId));
      expect(error.code).toBe("NOT_FOUND");
    }
    expect(await getTestDb().select().from(chatMessages)).toHaveLength(0);
  });

  it("rate-limits sends to 20 per 10 seconds per user", async () => {
    const clock = new TestClock();
    const server = await start({ clock });
    const me = await createChatMember();
    const room = await insertGlobalRoom();
    const client = await join(server, me);
    for (let i = 0; i < 21; i += 1) client.send(sendFrame(room.id, `n${i}`));
    const limited = await client.waitFor(frameOf("error", (frame) => frame.code === "RATE_LIMITED"));
    expect(limited.clientMessageId).not.toBeNull();
    expect(client.ofType("message")).toHaveLength(20);

    clock.advance(10_001);
    const clientMessageId = randomUUID();
    client.send(sendFrame(room.id, "otra vez", clientMessageId));
    await client.waitFor(frameOf("message", (frame) => frame.clientMessageId === clientMessageId));
    expect(await getTestDb().select().from(chatMessages)).toHaveLength(21);
  });

  it("caps frames of any kind at 60 per 10 seconds per user", async () => {
    const clock = new TestClock();
    const server = await start({ clock });
    const me = await createChatMember();
    const client = await join(server, me);
    // Batches of 10 stay under the pending-queue cap (a burst of > 32 closes with 4008).
    for (let batch = 0; batch < 6; batch += 1) {
      for (let i = 0; i < 10; i += 1) client.send({ type: "ping", ts: batch * 10 + i });
      await client.waitFor(frameOf("pong", (frame) => frame.ts === batch * 10 + 9));
    }
    client.send({ type: "ping", ts: 60 });
    const limited = await client.waitFor(frameOf("error", (frame) => frame.code === "RATE_LIMITED"));
    expect(limited.clientMessageId).toBeNull();
    expect(client.ofType("pong")).toHaveLength(60);
  });

  it("closes a socket that floods the frame queue", async () => {
    const server = await start();
    const me = await createChatMember();
    const client = await join(server, me);
    for (let i = 0; i < 100; i += 1) client.send({ type: "ping" });
    expect((await client.closed).code).toBe(WsCloseCode.RateLimited);
  });

  it("answers ping with pong and relays throttled typing to other members only", async () => {
    const server = await start();
    const ana = await createChatMember({ displayName: "Ana" });
    const beto = await createChatMember();
    const room = await insertGlobalRoom();
    const a = await join(server, ana);
    const b = await join(server, beto);

    a.send({ type: "ping", ts: 42 });
    expect(await a.waitFor(frameOf("pong"))).toEqual({ type: "pong", ts: 42 });
    a.send({ type: "typing", roomId: room.id });
    a.send({ type: "typing", roomId: room.id });
    const typing = await b.waitFor(frameOf("typing"));
    expect(typing).toEqual({
      type: "typing",
      roomId: room.id,
      userId: ana.user.id,
      displayName: "Ana"
    });
    a.send({ type: "ping" });
    await a.waitFor(frameOf("pong", (frame) => frame.ts === null));
    await sleep(50);
    expect(b.ofType("typing")).toHaveLength(1);
    expect(a.ofType("typing")).toHaveLength(0);
  });

  it("stores read frames monotonically", async () => {
    const server = await start();
    const me = await createChatMember();
    const room = await insertGlobalRoom();
    const older = await insertMessage({
      roomId: room.id,
      senderUserId: null,
      createdAt: new Date("2026-09-01T00:00:00Z")
    });
    const newer = await insertMessage({
      roomId: room.id,
      senderUserId: null,
      createdAt: new Date("2026-09-02T00:00:00Z")
    });
    const client = await join(server, me);
    client.send({ type: "read", roomId: room.id, messageId: newer.id });
    client.send({ type: "read", roomId: room.id, messageId: older.id });
    client.send({ type: "read", roomId: room.id, messageId: randomUUID() });
    await client.waitFor(frameOf("error", (frame) => frame.code === "NOT_FOUND"));
    const [state] = await getTestDb()
      .select()
      .from(chatReadStates)
      .where(and(eq(chatReadStates.roomId, room.id), eq(chatReadStates.userId, me.user.id)));
    expect(state?.lastReadMessageId).toBe(newer.id);
  });

  it("broadcasts message_deleted when a message is deleted over REST", async () => {
    const server = await start();
    const ana = await createChatMember();
    const beto = await createChatMember();
    const room = await insertGlobalRoom();
    const a = await join(server, ana);
    const b = await join(server, beto);
    a.send(sendFrame(room.id, "me arrepiento"));
    const { message } = await b.waitFor(frameOf("message"));

    const response = await server.inject({
      method: "DELETE",
      url: `/api/chat/messages/${message.id}`,
      ...ana.auth
    });
    expect(response.statusCode).toBe(204);
    for (const client of [a, b]) {
      expect(await client.waitFor(frameOf("message_deleted"))).toEqual({
        type: "message_deleted",
        roomId: room.id,
        messageId: message.id
      });
    }
  });
});

describe("chat socket lifecycle", () => {
  it("closes sockets of revoked sessions and disabled users on the periodic re-check", async () => {
    const server = await start();
    const revoked = await createChatMember();
    const disabled = await createChatMember();
    const fine = await createChatMember();
    const r = await join(server, revoked);
    const d = await join(server, disabled);
    const f = await join(server, fine);

    await getTestDb()
      .update(sessions)
      .set({ revokedAt: new Date(), revokedReason: "admin_revoked" })
      .where(eq(sessions.id, revoked.sessionId));
    await getTestDb().update(users).set({ status: "disabled" }).where(eq(users.id, disabled.user.id));

    expect(await hub(server).recheckSessions()).toBe(2);
    expect((await r.closed).code).toBe(WsCloseCode.SessionRevoked);
    expect((await d.closed).code).toBe(WsCloseCode.SessionRevoked);
    await f.waitFor(frameOf("presence", (frame) => frame.onlineUserIds.length === 1));
    expect(
      hub(server)
        .connections()
        .map((connection) => connection.principal.userId)
    ).toEqual([fine.user.id]);
  });

  it("closes sessions that expired by the injected clock", async () => {
    const clock = new TestClock();
    const server = await start({ clock });
    const me = await createChatMember();
    const client = await join(server, me);
    clock.advance(91 * 24 * 60 * 60 * 1000);
    expect(await hub(server).recheckSessions()).toBe(1);
    expect((await client.closed).code).toBe(WsCloseCode.SessionRevoked);
  });

  it("exposes closeSocketsForSession/closeSocketsForUser for T1/T8, which also burn unused tickets", async () => {
    const server = await start();
    const me = await createChatMember();
    const first = await join(server, me);
    expect(closeSocketsForSession(server, me.sessionId)).toBe(1);
    expect((await first.closed).code).toBe(WsCloseCode.SessionRevoked);

    // The closed session cannot register again (handshake-race guard), so use a new one.
    const session = await createSession(me.user.id);
    const again: ChatMember = { user: me.user, sessionId: session.id, auth: await bearerFor(me.user, session) };
    const second = await join(server, again);
    const { ticket } = await issueTicket(server, again);
    expect(closeSocketsForUser(server, me.user.id)).toBe(1);
    expect((await second.closed).code).toBe(WsCloseCode.SessionRevoked);
    const late = await open(server, { ticket });
    expect((await late.closed).code).toBe(WS_POLICY_VIOLATION);
  });

  it("terminates sockets that miss a heartbeat pong", async () => {
    const server = await start();
    const me = await createChatMember();
    const client = await join(server, me);
    // `injectWS` clients do not auto-pong; answer like a browser would.
    let answer = true;
    client.ws.on("ping", () => {
      if (answer) client.ws.pong();
    });
    const chat = hub(server);
    expect(chat.heartbeat()).toBe(0);
    await sleep(50);
    // The client answered the ping, so it survives the next round.
    expect(chat.heartbeat()).toBe(0);
    answer = false;
    await sleep(50);
    expect(chat.heartbeat()).toBe(1);
    expect((await client.closed).code).toBe(1006);
  });

  it("never logs message bodies or tickets", async () => {
    const logs: string[] = [];
    const server = await start({ logs });
    const me = await createChatMember();
    const room = await insertGlobalRoom();
    const { ticket } = await issueTicket(server, me);
    const client = await open(server, { ticket });
    clients.push(client);
    await client.waitFor(frameOf("presence"));
    const body = `cuerpo-secreto-${randomUUID()}`;
    client.send(sendFrame(room.id, body));
    await client.waitFor(frameOf("message"));
    client.send("{roto");
    await client.waitFor(frameOf("error"));
    const replay = await open(server, { ticket });
    await replay.closed;

    const output = logs.join("\n");
    expect(output).toContain("/api/chat/ws");
    expect(output).not.toContain(ticket);
    expect(output).not.toContain(body);
  });
});
