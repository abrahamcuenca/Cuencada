/**
 * Event rooms on the chat WebSocket (ADR 0001 §7, Security requirement 6)
 * [SEC]: frames of an event room (`message`, `typing`, `message_deleted`,
 * `room_preview`) reach only its participants (admins only when they take
 * part, PR #54 M1); a member who loses access gets `room_removed` and then
 * nothing for that room; inbound frames re-check access. A non-participant
 * admin moderates through the audited, read-only REST history.
 */
import { randomUUID } from "node:crypto";
import { eventDetailSchema } from "@cuencada/types";
import { eq } from "drizzle-orm";
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
import { getTestDb } from "../../../test/helpers/db.js";
import { callAs, insertEvent } from "../../../test/helpers/events.js";
import { FakeStorage } from "../../../test/helpers/fakes.js";
import type { App } from "../../app.js";
import { auditLogs } from "../../db/schema/index.js";

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
  it("delivers message, typing, deletion and preview frames to participants only (a participant admin included)", async () => {
    await insertGlobalRoom();
    const ana = await createChatMember();
    const bea = await createChatMember();
    const outsider = await createChatMember();
    const admin = await createChatMember({ role: "admin" });
    const { roomId } = await insertEvent({ organizerId: ana.user.id, participantIds: [bea.user.id, admin.user.id] });
    if (roomId === null) throw new Error("no room");
    const [anaWs, beaWs, outsiderWs, adminWs] = await Promise.all([ana, bea, outsider, admin].map(connect));
    if (anaWs === undefined || beaWs === undefined || outsiderWs === undefined || adminWs === undefined) throw new Error("connect");

    send(anaWs, roomId, "Hola primos");
    const message = await beaWs.waitFor(frameOf("message", (frame) => frame.message.roomId === roomId));
    await adminWs.waitFor(frameOf("message", (frame) => frame.message.roomId === roomId));
    // The participant admin works normally: lists the room and can send.
    const adminRooms = (await callAs(app, admin, "GET", "/api/chat/rooms")).json<Array<{ id: string }>>();
    expect(adminRooms.map((room) => room.id)).toContain(roomId);
    send(adminWs, roomId, "Soy admin y participo");
    const latest = await anaWs.waitFor(frameOf("message", (frame) => frame.message.body === "Soy admin y participo"));
    beaWs.send({ type: "typing", roomId });
    await anaWs.waitFor(frameOf("typing", (frame) => frame.roomId === roomId));
    expect(message.message.body).toBe("Hola primos");
    // Deleting the newest message also refreshes the room preview.
    const deleted = await callAs(app, admin, "DELETE", `/api/chat/messages/${latest.message.id}`);
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
    const { event, roomId } = await insertEvent({ organizerId: ana.user.id, participantIds: [bea.user.id, admin.user.id] });
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

  it("keeps a non-participant admin out of event chats: no list entry, no frames, sends refused; history is read-only and audited (PR #54 M1)", async () => {
    await insertGlobalRoom();
    const ana = await createChatMember();
    const admin = await createChatMember({ role: "admin" });
    const { event, roomId } = await insertEvent({ title: "Viaje privado", organizerId: ana.user.id, visibility: "participants" });
    if (roomId === null) throw new Error("no room");
    const anaWs = await connect(ana);
    const adminWs = await connect(admin);

    const rooms = await callAs(app, admin, "GET", "/api/chat/rooms");
    expect(rooms.statusCode).toBe(200);
    expect(rooms.json<Array<{ id: string; kind: string }>>().map((room) => room.kind)).not.toContain("event");
    expect(rooms.body).not.toContain("Viaje privado");

    send(anaWs, roomId, "Solo para participantes");
    anaWs.send({ type: "typing", roomId });
    await anaWs.waitFor(frameOf("message", (frame) => frame.message.body === "Solo para participantes"));
    for (const frame of [
      { type: "send", roomId, body: "Intervengo", clientMessageId: randomUUID() },
      { type: "typing", roomId },
      { type: "read", roomId, messageId: randomUUID() }
    ]) {
      const errors = adminWs.ofType("error").length;
      adminWs.send(frame);
      if (frame.type !== "typing") {
        await adminWs.waitFor(frameOf("error", (error) => error.code === "NOT_FOUND" && adminWs.ofType("error").length > errors));
      }
    }
    await sleep(200);
    expect(roomFrames(adminWs, roomId)).toEqual([]);
    expect(JSON.stringify(adminWs.frames)).not.toContain("Solo para participantes");
    expect(JSON.stringify(anaWs.frames)).not.toContain("Intervengo");
    expect((await callAs(app, admin, "POST", `/api/chat/rooms/${roomId}/read`, { messageId: randomUUID() })).statusCode).toBe(404);

    // The web moderation view: the detail still offers the chat, and the history read is audited.
    const detail = eventDetailSchema.parse((await callAs(app, admin, "GET", `/api/events/${event.year}/${event.slug}`)).json());
    expect(detail.hasChat).toBe(true);
    expect(detail.chatRoomId).toBe(roomId);
    const history = await callAs(app, admin, "GET", `/api/chat/rooms/${roomId}/messages`);
    expect(history.statusCode).toBe(200);
    expect(history.body).toContain("Solo para participantes");
    const audits = await getTestDb().select().from(auditLogs).where(eq(auditLogs.action, "event.admin_viewed"));
    expect(audits.map((row) => row.entityId)).toEqual([event.id]);

    // Moderation delete still works (audited as chat_message.deleted).
    const [first] = (history.json<{ messages: Array<{ id: string }> }>()).messages;
    if (first === undefined) throw new Error("no message");
    expect((await callAs(app, admin, "DELETE", `/api/chat/messages/${first.id}`)).statusCode).toBe(204);
    expect(await getTestDb().select().from(auditLogs).where(eq(auditLogs.action, "chat_message.deleted"))).toHaveLength(1);
    await anaWs.waitFor(frameOf("message_deleted", (frame) => frame.roomId === roomId));
    expect(roomFrames(adminWs, roomId)).toEqual([]);
  });
});
