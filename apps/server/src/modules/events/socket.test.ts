/**
 * Event rooms on the chat WebSocket (ADR 0001 §7, Security requirement 6)
 * [SEC]: frames of an event room (`message`, `typing`, `message_deleted`,
 * `room_preview`) reach only its participants and admins; a member who
 * loses access gets `room_removed` and then nothing for that room; inbound
 * frames re-check access.
 */
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type ChatMember,
  type ChatTestClient,
  connectMember,
  createChatMember,
  frameOf,
  insertGlobalRoom,
  sleep
} from "../../../test/helpers/chat.js";
import { createTestApp } from "../../../test/helpers/app.js";
import { callAs, insertEvent } from "../../../test/helpers/events.js";
import { FakeStorage } from "../../../test/helpers/fakes.js";
import type { App } from "../../app.js";

let app: App;
const clients: ChatTestClient[] = [];

beforeEach(async () => {
  app = await createTestApp({ storage: new FakeStorage() });
});

afterEach(async () => {
  for (const client of clients.splice(0)) client.ws.terminate();
  await app.close();
});

async function connect(member: ChatMember): Promise<ChatTestClient> {
  const client = await connectMember(app, member);
  clients.push(client);
  return client;
}

function send(client: ChatTestClient, roomId: string, body: string): string {
  const clientMessageId = randomUUID();
  client.send({ type: "send", roomId, body, clientMessageId });
  return clientMessageId;
}

/** Frames of `roomId` (any type carrying it) received by `client`. */
function roomFrames(client: ChatTestClient, roomId: string): string[] {
  return client.frames
    .filter((frame) => ("roomId" in frame && frame.roomId === roomId) || (frame.type === "message" && frame.message.roomId === roomId))
    .map((frame) => frame.type);
}

describe("event room fan-out", () => {
  it("delivers message, typing, deletion and preview frames to participants and admins only", async () => {
    await insertGlobalRoom();
    const ana = await createChatMember();
    const bea = await createChatMember();
    const outsider = await createChatMember();
    const admin = await createChatMember({ role: "admin" });
    const { roomId } = await insertEvent({ organizerId: ana.user.id, participantIds: [bea.user.id] });
    if (roomId === null) throw new Error("no room");
    const [anaWs, beaWs, outsiderWs, adminWs] = await Promise.all([ana, bea, outsider, admin].map(connect));
    if (anaWs === undefined || beaWs === undefined || outsiderWs === undefined || adminWs === undefined) throw new Error("connect");

    send(anaWs, roomId, "Hola primos");
    const message = await beaWs.waitFor(frameOf("message", (frame) => frame.message.roomId === roomId));
    await adminWs.waitFor(frameOf("message", (frame) => frame.message.roomId === roomId));
    beaWs.send({ type: "typing", roomId });
    await anaWs.waitFor(frameOf("typing", (frame) => frame.roomId === roomId));
    const deleted = await callAs(app, ana, "DELETE", `/api/chat/messages/${message.message.id}`);
    expect(deleted.statusCode).toBe(204);
    await beaWs.waitFor(frameOf("room_preview", (frame) => frame.roomId === roomId));

    // The outsider tries to read and write the room: refused, and nothing arrives.
    outsiderWs.send({ type: "send", roomId, body: "Me cuelo", clientMessageId: randomUUID() });
    await outsiderWs.waitFor(frameOf("error", (frame) => frame.code === "NOT_FOUND"));
    outsiderWs.send({ type: "typing", roomId });
    await sleep(200);
    expect(roomFrames(outsiderWs, roomId)).toEqual([]);
    expect(JSON.stringify(outsiderWs.frames)).not.toContain("Hola primos");
    expect(roomFrames(adminWs, roomId)).toEqual(expect.arrayContaining(["message", "message_deleted", "room_preview"]));
  });

  it("sends room_removed to a removed participant and then nothing for that room", async () => {
    const ana = await createChatMember();
    const bea = await createChatMember();
    const { event, roomId } = await insertEvent({ organizerId: ana.user.id, participantIds: [bea.user.id] });
    if (roomId === null) throw new Error("no room");
    const anaWs = await connect(ana);
    const beaWs = await connect(bea);
    send(anaWs, roomId, "Antes");
    await beaWs.waitFor(frameOf("message", (frame) => frame.message.roomId === roomId));

    const removed = await callAs(app, ana, "DELETE", `/api/events/${event.id}/participants/${bea.user.id}`);
    expect(removed.statusCode).toBe(200);
    // Sent before the HTTP answer (the hub refresh is awaited by the route).
    await beaWs.waitFor(frameOf("room_removed", (frame) => frame.roomId === roomId), 500);
    const before = roomFrames(beaWs, roomId).length;

    send(anaWs, roomId, "Después");
    anaWs.send({ type: "typing", roomId });
    await anaWs.waitFor(frameOf("message", (frame) => frame.message.body === "Después"));
    await sleep(200);
    expect(roomFrames(beaWs, roomId)).toHaveLength(before);
    expect(roomFrames(beaWs, roomId).at(-1)).toBe("room_removed");
    // Her own sends to the room are refused now.
    beaWs.send({ type: "send", roomId, body: "¿Sigo?", clientMessageId: randomUUID() });
    await beaWs.waitFor(frameOf("error", (frame) => frame.code === "NOT_FOUND"));
    const history = await callAs(app, bea, "GET", `/api/chat/rooms/${roomId}/messages`);
    expect(history.statusCode).toBe(404);
  });

  it("removes the room from plain participants when the event goes back to draft, and from everyone on delete", async () => {
    const ana = await createChatMember();
    const bea = await createChatMember();
    const admin = await createChatMember({ role: "admin" });
    const { event, roomId } = await insertEvent({ organizerId: ana.user.id, participantIds: [bea.user.id] });
    if (roomId === null) throw new Error("no room");
    const anaWs = await connect(ana);
    const beaWs = await connect(bea);
    const adminWs = await connect(admin);

    expect((await callAs(app, ana, "PATCH", `/api/events/${event.id}`, { status: "draft" })).statusCode).toBe(200);
    await beaWs.waitFor(frameOf("room_removed", (frame) => frame.roomId === roomId), 500);
    expect(anaWs.frames.some((frame) => frame.type === "room_removed")).toBe(false);
    send(anaWs, roomId, "Solo organizadores");
    await adminWs.waitFor(frameOf("message", (frame) => frame.message.body === "Solo organizadores"));
    await sleep(100);
    expect(JSON.stringify(beaWs.frames)).not.toContain("Solo organizadores");

    expect((await callAs(app, admin, "DELETE", `/api/events/${event.id}`)).statusCode).toBe(204);
    for (const client of [anaWs, adminWs]) await client.waitFor(frameOf("room_removed", (frame) => frame.roomId === roomId), 500);
  });

  it("lets a member who joins read the room at once", async () => {
    const ana = await createChatMember();
    const bea = await createChatMember();
    const { event, roomId } = await insertEvent({ organizerId: ana.user.id });
    if (roomId === null) throw new Error("no room");
    const anaWs = await connect(ana);
    const beaWs = await connect(bea);
    send(anaWs, roomId, "Antes de unirse");
    await anaWs.waitFor(frameOf("message", (frame) => frame.message.body === "Antes de unirse"));
    expect((await callAs(app, bea, "POST", `/api/events/${event.id}/join`)).statusCode).toBe(200);
    send(anaWs, roomId, "Bienvenida");
    await beaWs.waitFor(frameOf("message", (frame) => frame.message.body === "Bienvenida"));
    expect(JSON.stringify(beaWs.frames)).not.toContain("Antes de unirse");
  });
});
