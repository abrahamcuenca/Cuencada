import { WS_MAX_FRAME_BYTES, WS_PING_INTERVAL_MS, WsCloseCode } from "@cuencada/types";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpResponse, http } from "msw";
import { apiUrl, authenticatedState, errorBody, makeUser } from "../../../test/auth";
import { createTestServer } from "../../../test/msw";
import { type AppStore, makeStore } from "../../app/store";
import { credentialsReceived, loggedOut } from "../auth/authSlice";
import { type ChatHubEvent, resetChatEventsForTests, sendChatFrame, subscribeChatEvents } from "./events";
import {
  BACKOFF_MAX_MS,
  BURST_BUDGET,
  backoffDelay,
  buildChatSocketUrl,
  type ChatConnection,
  configureChatSocketForTests,
  getChatConnection,
  HIDDEN_PAUSE_MS,
  LIVENESS_TIMEOUT_MS,
  parseServerFrame,
  resetChatSocketForTests,
  SEND_ACK_TIMEOUT_MS,
  SEND_BUDGET
} from "./socket";
import { createFakeSocket, FakeSocket } from "./testing/fakeSocket";
import { type ChatDb, chatHandlers, frames, makeChatDb, makeMessage, ticketValue } from "./testing/fixtures";

const server = createTestServer();
let db: ChatDb;
let store: AppStore;
let events: ChatHubEvent[];

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterAll(() => server.close());
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"], shouldAdvanceTime: true });
  db = makeChatDb();
  server.use(...chatHandlers(db));
  FakeSocket.reset();
  // random() = 0 → the shortest jittered delay (half the window).
  configureChatSocketForTests({ createSocket: createFakeSocket, random: () => 0 });
  store = makeStore(authenticatedState());
  events = [];
  subscribeChatEvents((event) => events.push(event));
});
afterEach(() => {
  resetChatSocketForTests();
  resetChatEventsForTests();
  server.resetHandlers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
});

/** Waits until the client has created `count` sockets. */
async function socketCount(count: number): Promise<FakeSocket> {
  await vi.waitFor(() => expect(FakeSocket.instances).toHaveLength(count));
  return FakeSocket.latest();
}

async function connectedSocket(connection: ChatConnection): Promise<FakeSocket> {
  const socket = await socketCount(FakeSocket.instances.length + 1);
  socket.open();
  expect(connection.getStatus()).toBe("open");
  return socket;
}

describe("backoffDelay", () => {
  it("doubles from 1 s with equal jitter and caps at 30 s", () => {
    expect(backoffDelay(0, 0)).toBe(500);
    expect(backoffDelay(0, 0.999)).toBe(1000);
    expect(backoffDelay(1, 0)).toBe(1000);
    expect(backoffDelay(3, 0.5)).toBe(6000);
    expect(backoffDelay(10, 1)).toBe(BACKOFF_MAX_MS);
    expect(backoffDelay(50, 0)).toBe(BACKOFF_MAX_MS / 2);
  });
});

describe("buildChatSocketUrl", () => {
  const ticket = { ticket: ticketValue(1), expiresAt: "2026-10-06T10:00:30.000Z", wsPath: "/api/chat/ws" };

  it("uses wss: on the API host and puts the ticket in the query", () => {
    expect(buildChatSocketUrl(ticket, "https://cuencada.com/api", false)).toBe(`wss://cuencada.com/api/chat/ws?ticket=${ticket.ticket}`);
  });

  it("allows ws: only when insecure is allowed (dev)", () => {
    expect(buildChatSocketUrl(ticket, "http://localhost:5173/api", true)).toBe(`ws://localhost:5173/api/chat/ws?ticket=${ticket.ticket}`);
    expect(buildChatSocketUrl(ticket, "http://localhost:5173/api", false)).toBeNull();
  });

  it("never lets the response choose another host", () => {
    for (const wsPath of ["//evil.example/ws", "https://evil.example/ws", "/api/../../ws", "/api/chat/ws?x=1", "api/chat/ws", "/\\evil.example"]) {
      expect(buildChatSocketUrl({ ...ticket, wsPath }, "https://cuencada.com/api", false)).toBeNull();
    }
  });
});

describe("parseServerFrame", () => {
  it("accepts contract frames", () => {
    expect(parseServerFrame(JSON.stringify(frames.message(makeMessage(1))))).toMatchObject({ type: "message" });
    expect(parseServerFrame(JSON.stringify({ type: "pong", ts: null }))).toEqual({ type: "pong", ts: null });
  });

  it("drops non-text, non-JSON, unknown, malformed and oversized frames", () => {
    const valid = frames.message(makeMessage(1));
    expect(parseServerFrame(new ArrayBuffer(8))).toBeNull();
    expect(parseServerFrame("not json")).toBeNull();
    expect(parseServerFrame(JSON.stringify({ type: "eval", code: "alert(1)" }))).toBeNull();
    expect(parseServerFrame(JSON.stringify({ ...valid, message: { ...makeMessage(1), id: "nope" } }))).toBeNull();
    expect(parseServerFrame(JSON.stringify({ ...valid, message: { ...makeMessage(1), body: "x".repeat(2001) } }))).toBeNull();
    expect(parseServerFrame(JSON.stringify({ type: "pong", ts: null, pad: "x".repeat(WS_MAX_FRAME_BYTES) }))).toBeNull();
    // Multi-byte text over the byte cap even though its length is under it.
    expect(parseServerFrame(JSON.stringify({ type: "pong", ts: null, pad: "ñ".repeat(WS_MAX_FRAME_BYTES / 2) }))).toBeNull();
  });
});

describe("ChatConnection lifecycle", { timeout: 15_000 }, () => {
  it("gets a ticket, connects, and reconnects with a fresh ticket after backoff", async () => {
    const connection = getChatConnection(store);
    const release = connection.acquire();
    expect(connection.getStatus()).toBe("connecting");

    const first = await connectedSocket(connection);
    expect(first.url).toBe(`ws://localhost:3000/api/chat/ws?ticket=${ticketValue(1)}`);
    expect(events).toContainEqual({ type: "open", resumed: false });

    first.serverClose(1006);
    expect(connection.getStatus()).toBe("reconnecting");
    // random() = 0 → 500 ms. (Margins absorb the real time `shouldAdvanceTime` adds.)
    await vi.advanceTimersByTimeAsync(400);
    expect(db.tickets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(100);
    const second = await socketCount(2);
    expect(second.ticket).toBe(ticketValue(2));
    second.open();
    expect(events).toContainEqual({ type: "open", resumed: true });
    release();
  });

  it("backs off exponentially while connections keep failing", async () => {
    const connection = getChatConnection(store);
    connection.acquire();
    (await socketCount(1)).serverClose(1006);
    await vi.advanceTimersByTimeAsync(500);
    (await socketCount(2)).serverClose(1006);
    // Second retry: a 2 s window → 1 s with random() = 0. Third: 4 s → 2 s.
    await vi.advanceTimersByTimeAsync(900);
    expect(FakeSocket.instances).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(100);
    (await socketCount(3)).serverClose(1006);
    await vi.advanceTimersByTimeAsync(1900);
    expect(FakeSocket.instances).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(100);
    await socketCount(4);
  });

  it("closes the socket on logout and does not reconnect", async () => {
    const connection = getChatConnection(store);
    connection.acquire();
    const socket = await connectedSocket(connection);

    store.dispatch(loggedOut());
    expect(socket.closedByClient).toBe(1000);
    expect(connection.getStatus()).toBe("idle");
    expect(sendChatFrame({ type: "typing", roomId: makeMessage(1).roomId })).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeSocket.instances).toHaveLength(1);
    expect(db.tickets).toHaveLength(1);
  });

  it("reconnects with a new ticket when another account signs in", async () => {
    const connection = getChatConnection(store);
    connection.acquire();
    const socket = await connectedSocket(connection);

    store.dispatch(credentialsReceived({ accessToken: "token-b", user: makeUser({ id: "7a1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b" }) }));
    expect(socket.closedByClient).toBe(1000);
    // The account switch also resets the API cache (aborting the first ticket request): retried after backoff.
    await vi.advanceTimersByTimeAsync(1000);
    const next = await socketCount(2);
    expect(next.ticket).toMatch(/^tkt000[23]/);
  });

  it("closes when the last chat screen unmounts", async () => {
    const connection = getChatConnection(store);
    const releaseA = connection.acquire();
    const releaseB = connection.acquire();
    const socket = await connectedSocket(connection);
    releaseA();
    await Promise.resolve();
    expect(socket.closedByClient).toBeNull();
    releaseB();
    await Promise.resolve();
    expect(socket.closedByClient).toBe(1000);
    expect(connection.getStatus()).toBe("idle");
  });

  it("waits while offline and reconnects at once when back online", async () => {
    const connection = getChatConnection(store);
    connection.acquire();
    const socket = await connectedSocket(connection);

    vi.stubGlobal("navigator", { ...navigator, onLine: false });
    window.dispatchEvent(new Event("offline"));
    expect(socket.closedByClient).toBe(1000);
    expect(connection.getStatus()).toBe("offline");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeSocket.instances).toHaveLength(1);

    vi.stubGlobal("navigator", { ...navigator, onLine: true });
    window.dispatchEvent(new Event("online"));
    await socketCount(2);
  });

  it("pauses after the tab is hidden for a long time and resumes when visible", async () => {
    const connection = getChatConnection(store);
    connection.acquire();
    const socket = await connectedSocket(connection);
    socket.autoPong = true;

    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(HIDDEN_PAUSE_MS - 1000);
    expect(socket.closedByClient).toBeNull();
    await vi.advanceTimersByTimeAsync(1000);
    expect(socket.closedByClient).toBe(1000);
    expect(connection.getStatus()).toBe("paused");

    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
    await socketCount(2);
  });

  it("stops for good on a 403 ticket (unverified email)", async () => {
    db.ticketStatus = 403;
    const connection = getChatConnection(store);
    connection.acquire();
    await vi.waitFor(() => expect(connection.getStatus()).toBe("forbidden"));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeSocket.instances).toHaveLength(0);
  });

  it("stops on close code 4003 and retries on a server error ticket", async () => {
    db.ticketStatus = 500;
    const connection = getChatConnection(store);
    connection.acquire();
    await vi.waitFor(() => expect(connection.getStatus()).toBe("connecting"));
    db.ticketStatus = 201;
    await vi.advanceTimersByTimeAsync(500);
    const socket = await socketCount(1);
    socket.open();
    socket.serverClose(WsCloseCode.Forbidden);
    expect(connection.getStatus()).toBe("forbidden");
  });

  it("on 4010 (session revoked) runs the auth flow instead of reconnecting blindly", async () => {
    const connection = getChatConnection(store);
    connection.acquire();
    const socket = await connectedSocket(connection);
    server.use(http.get(apiUrl("/chat/rooms"), () => HttpResponse.json(errorBody("UNAUTHENTICATED", "Sesión revocada."), { status: 401 })));

    socket.serverClose(WsCloseCode.SessionRevoked);
    await vi.waitFor(() => expect(store.getState().auth.status).toBe("anonymous"));
    expect(connection.getStatus()).toBe("idle");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeSocket.instances).toHaveLength(1);
    expect(db.tickets).toHaveLength(1);
  });

  it("on 4010 reconnects when the session turns out to be valid", async () => {
    const connection = getChatConnection(store);
    connection.acquire();
    (await connectedSocket(connection)).serverClose(WsCloseCode.SessionRevoked);
    await vi.advanceTimersByTimeAsync(1000);
    await socketCount(2);
  });

  it("retries with a fresh ticket after 1008 (used or expired ticket)", async () => {
    const connection = getChatConnection(store);
    connection.acquire();
    (await socketCount(1)).serverClose(1008);
    await vi.advanceTimersByTimeAsync(500);
    expect((await socketCount(2)).ticket).toBe(ticketValue(2));
  });

  it("keeps sends under the server's rate limits, queueing the extra ones in order", async () => {
    const connection = getChatConnection(store);
    connection.acquire();
    const socket = await connectedSocket(connection);
    const roomId = makeMessage(1).roomId;
    const ids = Array.from({ length: 25 }, (_, index) => `aaaaaaaa-0000-4000-8000-${String(index).padStart(12, "0")}`);

    for (const clientMessageId of ids) expect(sendChatFrame({ type: "send", roomId, body: "Hola", clientMessageId })).toBe(true);
    const sent = (): unknown[] => socket.frames().filter((frame) => typeof frame === "object" && frame !== null && "clientMessageId" in frame);
    expect(sent()).toHaveLength(BURST_BUDGET.max);
    // Typing is dropped while over budget rather than queued.
    expect(sendChatFrame({ type: "typing", roomId })).toBe(false);

    // Bursts of 8 per second until the 10 s send budget (18) is used up…
    await vi.advanceTimersByTimeAsync(SEND_BUDGET.windowMs / 2);
    expect(sent()).toHaveLength(SEND_BUDGET.max);
    // …then the rest once the window slides.
    await vi.advanceTimersByTimeAsync(SEND_BUDGET.windowMs * 1.5);
    expect(sent().map((frame) => (frame as { clientMessageId: string }).clientMessageId)).toEqual(ids); // Test-only: filtered to send frames above.
  });

  it("drops a silent connection (no pong) and reconnects", async () => {
    const connection = getChatConnection(store);
    connection.acquire();
    const socket = await connectedSocket(connection);
    await vi.advanceTimersByTimeAsync(LIVENESS_TIMEOUT_MS + WS_PING_INTERVAL_MS);
    expect(socket.closedByClient).toBe(1000);
    expect(socket.frames()).toContainEqual(expect.objectContaining({ type: "ping" }));
    await vi.advanceTimersByTimeAsync(1000);
    await socketCount(2);
  });

  it("emits only valid frames and never logs", async () => {
    const consoleSpies = (["log", "info", "warn", "error", "debug"] as const).map((method) => vi.spyOn(console, method));
    const connection = getChatConnection(store);
    connection.acquire();
    const socket = await connectedSocket(connection);
    events.length = 0;

    socket.receive("<script>alert(1)</script>");
    socket.receive({ type: "message", message: { id: "x" }, clientMessageId: null });
    socket.receive({ type: "shell", cmd: "rm -rf" });
    expect(events).toEqual([]);

    socket.receive(frames.message(makeMessage(1)));
    expect(events).toEqual([{ type: "frame", frame: frames.message(makeMessage(1)) }]);
    for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
  });

  it("validates outgoing frames and marks a send failed when no echo arrives", async () => {
    const connection = getChatConnection(store);
    connection.acquire();
    const socket = await connectedSocket(connection);
    const clientMessageId = "aaaaaaaa-0000-4000-8000-000000000001";

    expect(sendChatFrame({ type: "send", roomId: makeMessage(1).roomId, body: "   ", clientMessageId })).toBe(false);
    expect(sendChatFrame({ type: "send", roomId: makeMessage(1).roomId, body: " Hola\u202E ", clientMessageId })).toBe(true);
    expect(socket.frames()).toEqual([{ type: "send", roomId: makeMessage(1).roomId, body: "Hola", clientMessageId }]);

    await vi.advanceTimersByTimeAsync(SEND_ACK_TIMEOUT_MS);
    expect(events).toContainEqual({ type: "send_failed", clientMessageId });
  });

  it("clears the echo timer when the echo arrives", async () => {
    const connection = getChatConnection(store);
    connection.acquire();
    const socket = await connectedSocket(connection);
    const clientMessageId = "aaaaaaaa-0000-4000-8000-000000000002";
    sendChatFrame({ type: "send", roomId: makeMessage(1).roomId, body: "Hola", clientMessageId });
    socket.receive(frames.message(makeMessage(9, { body: "Hola" }), clientMessageId));
    await vi.advanceTimersByTimeAsync(SEND_ACK_TIMEOUT_MS);
    expect(events.some((event) => event.type === "send_failed")).toBe(false);
  });
});
