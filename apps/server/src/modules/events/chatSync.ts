/**
 * Keeps the chat hub's event-room audiences in step with event writes
 * (ADR 0001 §7, Security requirement 6) [SEC].
 *
 * Every write that can change who reads an event's room (participants,
 * roles, status, visibility, delete) takes a {@link RoomSnapshot} **before**
 * its transaction and calls {@link syncEventRoom} (or
 * {@link removeEventRoom}) **after** the commit and **before** answering,
 * so the hub's recipient set is current before any client hears about the
 * change, and users who lost access get `room_removed`.
 */
import type { FastifyInstance } from "fastify";
import { chatHubOf } from "../chat/index.js";
import { loadRoomAudience } from "../chat/repository.js";
import { findEventRoomId } from "./repository.js";

/** Who could read the event's room before a change. */
export interface RoomSnapshot {
  roomId: string | null;
  readers: ReadonlySet<string> | null;
}

/**
 * Who can read the event's room now (call before the write's transaction).
 *
 * @param app - The app (`db`).
 * @param eventId - The event.
 */
export async function snapshotEventRoom(app: FastifyInstance, eventId: string): Promise<RoomSnapshot> {
  const roomId = await findEventRoomId(app.db, eventId);
  if (roomId === null) return { roomId: null, readers: null };
  const audience = await loadRoomAudience(app.db, roomId);
  return { roomId, readers: audience.kind === "users" ? audience.userIds : null };
}

/**
 * After the commit: reload the room's audience and send `room_removed` to
 * those who lost access. A failure here (the write is already committed)
 * drops every cached event audience, so the next fan-out reloads from the
 * database instead of using a stale set.
 */
export async function syncEventRoom(app: FastifyInstance, eventId: string, before: RoomSnapshot): Promise<void> {
  const hub = chatHubOf(app);
  if (hub === null) return;
  try {
    const roomId = before.roomId ?? (await findEventRoomId(app.db, eventId));
    if (roomId === null) return;
    await hub.refreshRoomAudience(roomId, before.readers);
  } catch (error) {
    hub.invalidateEventAudiences();
    app.log.error({ eventId, errorName: error instanceof Error ? error.name : "unknown" }, "event room audience refresh failed");
  }
}

/** After an event delete committed: its room is gone for everyone who could read it. */
export async function removeEventRoom(app: FastifyInstance, before: RoomSnapshot): Promise<void> {
  const hub = chatHubOf(app);
  if (hub === null || before.roomId === null) return;
  await hub.removeRoom(before.roomId, before.readers);
}
