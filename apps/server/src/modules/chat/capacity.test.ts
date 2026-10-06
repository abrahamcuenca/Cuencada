import { randomUUID } from "node:crypto";
import type { WsServerMessage } from "@cuencada/types";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import type { App } from "../../app.js";
import { profiles } from "../../db/schema/index.js";
import { createTestApp } from "../../../test/helpers/app.js";
import {
  type ChatMember,
  type ChatTestClient,
  connectChat,
  connectMember,
  createChatMember,
  frameOf,
  insertGlobalRoom,
  issueTicket,
  sleep
} from "../../../test/helpers/chat.js";
import { getTestDb } from "../../../test/helpers/db.js";
import { bearerFor, createSession } from "../../../test/helpers/factories.js";
import {
  type ChatConnection,
  type ChatHub,
  MAX_SOCKETS_PER_SESSION,
  MAX_SOCKETS_PER_USER,
  WS_NORMAL_CLOSURE,
  WS_TRY_AGAIN_LATER
} from "./hub.js";
import { chatHubOf } from "./index.js";
import { BUFFER_SKIP_LOW_PRIORITY_BYTES, BUFFER_TERMINATE_BYTES, type DeliverySocket, deliverFrame } from "./socket.js";

let app: App | undefined;
const clients: ChatTestClient[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.ws.terminate();
  await app?.close();
  app = undefined;
});

function hubOf(server: App): ChatHub {
  const found = chatHubOf(server);
  if (found === null) throw new Error("no chat hub");
  return found;
}

async function join(server: App, member: ChatMember): Promise<ChatTestClient> {
  const client = await connectMember(server, member);
  clients.push(client);
  return client;
}

/** Another live session (and bearer) for the same user. */
async function anotherSession(member: ChatMember): Promise<ChatMember> {
  const session = await createSession(member.user.id);
  return { user: member.user, sessionId: session.id, auth: await bearerFor(member.user, session) };
}

/** Override `bufferedAmount` on the server-side socket(s) of the app. */
function fakeBuffered(server: App, bytes: number): void {
  for (const socket of server.websocketServer.clients) {
    Object.defineProperty(socket, "bufferedAmount", { configurable: true, get: () => bytes });
  }
}

describe("connection caps", () => {
  it(`closes the oldest socket when a session opens socket ${MAX_SOCKETS_PER_SESSION + 1}`, async () => {
    app = await createTestApp();
    const me = await createChatMember();
    const sockets: ChatTestClient[] = [];
    for (let i = 0; i <= MAX_SOCKETS_PER_SESSION; i += 1) sockets.push(await join(app, me));

    const [oldest, ...rest] = sockets;
    const closed = await oldest?.closed;
    expect(closed).toEqual({ code: WS_NORMAL_CLOSURE, reason: "Demasiadas conexiones abiertas." });
    expect(oldest?.ofType("error").at(-1)).toMatchObject({ code: "CONFLICT" });
    await sleep(50);
    expect(hubOf(app).size).toBe(MAX_SOCKETS_PER_SESSION);
    for (const socket of rest) expect(socket.ws.readyState).toBe(socket.ws.OPEN);
  });

  it(`closes the oldest socket when a user opens socket ${MAX_SOCKETS_PER_USER + 1} across sessions`, async () => {
    app = await createTestApp();
    const first = await createChatMember();
    const sessions = [first, await anotherSession(first), await anotherSession(first)];
    const sockets: ChatTestClient[] = [];
    // 3 + 3 + 3 = 9 sockets, never more than 3 per session.
    for (const session of sessions) {
      for (let i = 0; i < 3; i += 1) sockets.push(await join(app, session));
    }

    expect((await sockets[0]?.closed)?.code).toBe(WS_NORMAL_CLOSURE);
    await sleep(50);
    expect(hubOf(app).size).toBe(MAX_SOCKETS_PER_USER);
    for (const socket of sockets.slice(1)) expect(socket.ws.readyState).toBe(socket.ws.OPEN);
  });

  it("refuses new sockets with 1013 at the global cap", async () => {
    app = await createTestApp();
    hubOf(app).caps.total = 2;
    const a = await createChatMember();
    const b = await createChatMember();
    const c = await createChatMember();
    await join(app, a);
    await join(app, b);
    const { ticket } = await issueTicket(app, c);
    const refused = await connectChat(app, { ticket });
    clients.push(refused);
    expect((await refused.closed).code).toBe(WS_TRY_AGAIN_LATER);
    expect(hubOf(app).size).toBe(2);
  });
});

describe("backpressure", () => {
  it("terminates a slow reader whose send buffer passes the cap", async () => {
    app = await createTestApp();
    const room = await insertGlobalRoom();
    const slow = await createChatMember();
    const fast = await createChatMember();
    const slowSocket = await join(app, slow);
    fakeBuffered(app, BUFFER_TERMINATE_BYTES + 1);
    const fastSocket = await join(app, fast);

    fastSocket.send({ type: "send", roomId: room.id, body: "hola", clientMessageId: randomUUID() });
    await fastSocket.waitFor(frameOf("message"));

    expect((await slowSocket.closed).code).toBe(1006);
    await sleep(50);
    expect(
      hubOf(app)
        .connections()
        .map((connection) => connection.principal.userId)
    ).toEqual([fast.user.id]);
  });

  it("skips typing and presence, but not messages, above the low-priority threshold", () => {
    const sent: string[] = [];
    let terminated = false;
    const socket = (buffered: number): DeliverySocket => ({
      readyState: 1,
      OPEN: 1,
      bufferedAmount: buffered,
      send: (data: unknown) => {
        sent.push(String(data));
      },
      terminate: () => {
        terminated = true;
      }
    });
    const typing: WsServerMessage = { type: "typing", roomId: randomUUID(), userId: randomUUID(), displayName: "Ana" };
    const pong: WsServerMessage = { type: "pong", ts: null };

    expect(deliverFrame(socket(0), typing)).toBe("sent");
    expect(deliverFrame(socket(BUFFER_SKIP_LOW_PRIORITY_BYTES + 1), typing)).toBe("skipped");
    expect(deliverFrame(socket(BUFFER_SKIP_LOW_PRIORITY_BYTES + 1), { type: "presence", onlineUserIds: [] })).toBe(
      "skipped"
    );
    expect(deliverFrame(socket(BUFFER_SKIP_LOW_PRIORITY_BYTES + 1), pong)).toBe("sent");
    expect(terminated).toBe(false);
    expect(deliverFrame(socket(BUFFER_TERMINATE_BYTES + 1), pong)).toBe("terminated");
    expect(terminated).toBe(true);
    expect(sent).toHaveLength(2);
  });
});

describe("presence privacy", () => {
  it("leaves members who are not listed in the directory out of presence (they still see themselves)", async () => {
    app = await createTestApp();
    const listed = await createChatMember();
    const hidden = await createChatMember();
    await getTestDb().update(profiles).set({ listedInDirectory: false }).where(eq(profiles.userId, hidden.user.id));
    const listedSocket = await join(app, listed);
    const hiddenSocket = await join(app, hidden);

    const own = hiddenSocket.ofType("presence").at(-1);
    expect(own?.onlineUserIds.sort()).toEqual([hidden.user.id, listed.user.id].sort());
    await sleep(50);
    for (const frame of listedSocket.ofType("presence")) expect(frame.onlineUserIds).not.toContain(hidden.user.id);

    // Unlisting while connected takes effect at the next re-check.
    await getTestDb().update(profiles).set({ listedInDirectory: false }).where(eq(profiles.userId, listed.user.id));
    await hubOf(app).recheckSessions();
    // Nobody is listed now: each member's presence is just themselves.
    await hiddenSocket.waitFor(frameOf("presence", (frame) => frame.onlineUserIds.join() === hidden.user.id));
    await listedSocket.waitFor(frameOf("presence", (frame) => frame.onlineUserIds.join() === listed.user.id));
  });
});

describe("handshake race", () => {
  it("refuses to register a socket whose session was closed after the handshake's DB check", async () => {
    app = await createTestApp();
    const hub = hubOf(app);
    const closes: number[] = [];
    const connection = (sessionId: string): ChatConnection => ({
      id: hub.allocateId(),
      principal: { userId: "u", sessionId, displayName: "Ana", listedInDirectory: true },
      alive: true,
      send: () => undefined,
      close: (code) => {
        closes.push(code);
      },
      ping: () => undefined,
      terminate: () => undefined
    });

    expect(hub.closeSession("s1")).toBe(0);
    expect(hub.add(connection("s1"))).toBe(false);
    expect(closes).toEqual([4010]);
    expect(hub.add(connection("s2"))).toBe(true);
    expect(hub.size).toBe(1);
  });
});
