/**
 * WP-6.1 notifications [SEC] (ADR 0001 §8, requirement 7): the writers
 * (coalescing, no self-notification, the per-user cap, retract/seen), the
 * retention job, the routes (keyset feed, read-time visibility filtering,
 * unread count, mark read own rows only), the actor PII rules and the
 * WebSocket push to the recipient only.
 */
import { randomUUID } from "node:crypto";
import {
  NOTIFICATION_RETENTION_DAYS,
  NOTIFICATIONS_PER_USER_MAX,
  type Notification,
  NotificationKind,
  notificationDedupeKey,
  notificationPageSchema,
  type Page,
  unreadCountSchema
} from "@cuencada/types";
import { and, eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ChatTestClient, connectMember, createChatMember, frameOf, sleep } from "../../../test/helpers/chat.js";
import { createTestApp } from "../../../test/helpers/app.js";
import { getTestDb } from "../../../test/helpers/db.js";
import { callAs, type EventActor, eventActor, insertAlbumMedia, insertEvent } from "../../../test/helpers/events.js";
import { FakeStorage } from "../../../test/helpers/fakes.js";
import { insertPerson } from "../../../test/helpers/family.js";
import { createCuencada, insertMedia } from "../../../test/helpers/media.js";
import type { App } from "../../app.js";
import { eventParticipants, mediaItems, mediaLikes, notifications, profiles, treeLinkProposals } from "../../db/schema/index.js";
import { markNotificationSeen, pushNotifications, recordNotification, retractNotification } from "./notify.js";
import { purgeExpiredNotifications } from "./repository.js";

let app: App;
const clients: ChatTestClient[] = [];

beforeEach(async () => {
  app = await createTestApp({ storage: new FakeStorage() });
});

afterEach(async () => {
  for (const client of clients.splice(0)) client.ws.terminate();
  await app.close();
});

/** Runs `recordNotification` in its own transaction. */
function record(input: Parameters<typeof recordNotification>[1]): Promise<string | null> {
  return getTestDb().transaction((tx) => recordNotification(tx, input));
}

async function feed(actor: EventActor, query = ""): Promise<Page<Notification>> {
  const response = await callAs(app, actor, "GET", `/api/notifications${query}`);
  expect(response.statusCode, response.body).toBe(200);
  return notificationPageSchema.parse(response.json());
}

async function unread(actor: EventActor): Promise<number> {
  const response = await callAs(app, actor, "GET", "/api/notifications/unread-count");
  expect(response.statusCode, response.body).toBe(200);
  return unreadCountSchema.parse(response.json()).count;
}

async function rowsOf(userId: string): Promise<Array<typeof notifications.$inferSelect>> {
  return getTestDb().select().from(notifications).where(eq(notifications.userId, userId));
}

/** Edition photos uploaded by `uploaderId`, created one at a time (one edition row). */
async function editionPhotos(uploaderId: string, count: number): Promise<Array<typeof mediaItems.$inferSelect>> {
  const photos: Array<typeof mediaItems.$inferSelect> = [];
  for (let index = 0; index < count; index += 1) photos.push(await editionPhoto(uploaderId));
  return photos;
}

/** An edition photo uploaded by `uploaderId`. */
async function editionPhoto(uploaderId: string, year = 2026): Promise<typeof mediaItems.$inferSelect> {
  const [existing] = await getTestDb().execute<{ id: string }>(sql`select id from cuencadas where year = ${year}`);
  const cuencadaId = existing?.id ?? (await createCuencada({ year })).id;
  return insertMedia({ cuencadaId, uploadedByUserId: uploaderId });
}

describe("recordNotification", () => {
  it("never notifies the actor themself (returns null, writes nothing)", async () => {
    const ana = await eventActor();
    const photo = await editionPhoto(ana.user.id);
    expect(
      await record({ recipientUserId: ana.user.id, actorUserId: ana.user.id, kind: NotificationKind.PhotoLiked, target: { mediaId: photo.id } })
    ).toBeNull();
    expect(await rowsOf(ana.user.id)).toEqual([]);
  });

  it("coalesces likes per photo: one row, the latest actor, a count recomputed from the likes, re-fired as unread", async () => {
    const ana = await eventActor();
    const bea = await eventActor({ displayName: "Bea Ríos Luna" });
    const caro = await eventActor({ displayName: "Carolina Paz Soto" });
    const photo = await editionPhoto(ana.user.id);
    const like = async (actor: EventActor): Promise<string | null> => {
      await getTestDb().insert(mediaLikes).values({ mediaId: photo.id, userId: actor.user.id }).onConflictDoNothing();
      return record({ recipientUserId: ana.user.id, actorUserId: actor.user.id, kind: NotificationKind.PhotoLiked, target: { mediaId: photo.id } });
    };
    const first = await like(bea);
    const [before] = await rowsOf(ana.user.id);
    await getTestDb().update(notifications).set({ seenAt: new Date(), createdAt: new Date("2026-01-01T00:00:00Z") });
    const second = await like(caro);
    expect(second).toBe(first);
    const rows = await rowsOf(ana.user.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ count: 2, actorUserId: caro.user.id, seenAt: null, dedupeKey: notificationDedupeKey.like(photo.id) });
    expect(rows[0]?.createdAt.getTime()).toBeGreaterThan(new Date("2026-01-01T00:00:00Z").getTime());
    expect(before?.count).toBe(1);
    // Unlike + like again does not inflate the count.
    await getTestDb().delete(mediaLikes).where(and(eq(mediaLikes.mediaId, photo.id), eq(mediaLikes.userId, caro.user.id)));
    await like(caro);
    expect((await rowsOf(ana.user.id))[0]?.count).toBe(2);
    // The uploader's own like never counts.
    await getTestDb().insert(mediaLikes).values({ mediaId: photo.id, userId: ana.user.id });
    await like(bea);
    expect((await rowsOf(ana.user.id))[0]?.count).toBe(2);
  });

  it("grows a comment count while unread and restarts at 1 once seen", async () => {
    const ana = await eventActor();
    const bea = await eventActor();
    const photo = await editionPhoto(ana.user.id);
    const comment = (): Promise<string | null> =>
      record({ recipientUserId: ana.user.id, actorUserId: bea.user.id, kind: NotificationKind.PhotoCommented, target: { mediaId: photo.id } });
    await comment();
    await comment();
    await comment();
    expect((await rowsOf(ana.user.id))[0]?.count).toBe(3);
    await getTestDb().update(notifications).set({ seenAt: new Date() });
    await comment();
    expect((await rowsOf(ana.user.id))[0]).toMatchObject({ count: 1, seenAt: null });
  });

  it("refuses a target that does not match the kind and rolls back with the caller's transaction", async () => {
    const ana = await eventActor();
    const bea = await eventActor();
    const photo = await editionPhoto(ana.user.id);
    await expect(
      record({ recipientUserId: ana.user.id, actorUserId: bea.user.id, kind: NotificationKind.EventAdded, target: { mediaId: photo.id } })
    ).rejects.toThrow(/does not match/);
    await expect(
      getTestDb().transaction(async (tx) => {
        await recordNotification(tx, { recipientUserId: ana.user.id, actorUserId: bea.user.id, kind: NotificationKind.PhotoLiked, target: { mediaId: photo.id } });
        throw new Error("action failed");
      })
    ).rejects.toThrow("action failed");
    expect(await rowsOf(ana.user.id)).toEqual([]);
  });

  it(`keeps at most ${NOTIFICATIONS_PER_USER_MAX} rows per recipient, trimming seen ones first, then the oldest`, async () => {
    const ana = await eventActor();
    const bea = await eventActor();
    const other = await eventActor();
    const { event } = await insertEvent({ organizerId: bea.user.id });
    const old = new Date("2026-01-01T00:00:00Z");
    const filler = (userId: string, index: number, seen: boolean): typeof notifications.$inferInsert => ({
      userId,
      kind: NotificationKind.EventAdded,
      actorUserId: bea.user.id,
      eventId: event.id,
      dedupeKey: `filler:${index}`,
      seenAt: seen ? old : null,
      createdAt: new Date(old.getTime() + index * 1000)
    });
    // 10 seen (the newest of all) + 490 unread for Ana; another member's rows are never touched.
    const values = Array.from({ length: NOTIFICATIONS_PER_USER_MAX }, (_, index) => filler(ana.user.id, index, index >= 490));
    await getTestDb().insert(notifications).values(values);
    await getTestDb().insert(notifications).values(Array.from({ length: 3 }, (_, index) => filler(other.user.id, index, true)));
    const photo = await editionPhoto(ana.user.id);
    const id = await record({ recipientUserId: ana.user.id, actorUserId: bea.user.id, kind: NotificationKind.PhotoCommented, target: { mediaId: photo.id } });
    const rows = await rowsOf(ana.user.id);
    expect(rows).toHaveLength(NOTIFICATIONS_PER_USER_MAX);
    expect(rows.some((row) => row.id === id)).toBe(true);
    // The trimmed row is a seen one (the oldest seen), even though unread rows are older.
    expect(rows.filter((row) => row.seenAt !== null)).toHaveLength(9);
    expect(rows.some((row) => row.dedupeKey === "filler:490")).toBe(false);
    expect(rows.some((row) => row.dedupeKey === "filler:0")).toBe(true);
    expect(await rowsOf(other.user.id)).toHaveLength(3);
  });

  it("retracts one row and marks one seen, for that recipient only", async () => {
    const ana = await eventActor();
    const bea = await eventActor();
    const photo = await editionPhoto(bea.user.id);
    for (const recipient of [ana, bea]) {
      await record({ recipientUserId: recipient.user.id, actorUserId: null, kind: NotificationKind.PhotoTagRequest, target: { mediaId: photo.id } });
    }
    await getTestDb().transaction((tx) => markNotificationSeen(tx, ana.user.id, notificationDedupeKey.tag(photo.id)));
    expect((await rowsOf(ana.user.id))[0]?.seenAt).not.toBeNull();
    expect((await rowsOf(bea.user.id))[0]?.seenAt).toBeNull();
    await getTestDb().transaction((tx) => retractNotification(tx, ana.user.id, notificationDedupeKey.tag(photo.id)));
    expect(await rowsOf(ana.user.id)).toEqual([]);
    expect(await rowsOf(bea.user.id)).toHaveLength(1);
  });
});

describe("retention", () => {
  it(`deletes rows older than ${NOTIFICATION_RETENTION_DAYS} days and keeps newer ones`, async () => {
    const ana = await eventActor();
    const bea = await eventActor();
    const { event } = await insertEvent({ organizerId: bea.user.id });
    const now = new Date("2026-10-11T12:00:00Z");
    const day = 24 * 60 * 60 * 1000;
    await getTestDb()
      .insert(notifications)
      .values(
        [NOTIFICATION_RETENTION_DAYS + 5, NOTIFICATION_RETENTION_DAYS + 1, NOTIFICATION_RETENTION_DAYS - 1, 1].map((age, index) => ({
          userId: ana.user.id,
          kind: NotificationKind.EventAdded,
          eventId: event.id,
          dedupeKey: `age:${index}`,
          createdAt: new Date(now.getTime() - age * day)
        }))
      );
    expect(await purgeExpiredNotifications(getTestDb(), now, NOTIFICATION_RETENTION_DAYS)).toBe(2);
    expect((await rowsOf(ana.user.id)).map((row) => row.dedupeKey).sort()).toEqual(["age:2", "age:3"]);
  });
});

describe("GET /api/notifications", () => {
  it("lists the caller's own notifications newest first with keyset pages, never another member's", async () => {
    const ana = await eventActor();
    const bea = await eventActor({ displayName: "Bea Ríos Luna" });
    const photos = await editionPhotos(ana.user.id, 3);
    for (const photo of photos) {
      await record({ recipientUserId: ana.user.id, actorUserId: bea.user.id, kind: NotificationKind.PhotoCommented, target: { mediaId: photo.id } });
      await sleep(2);
    }
    await record({ recipientUserId: bea.user.id, actorUserId: ana.user.id, kind: NotificationKind.PhotoCommented, target: { mediaId: photos[0]?.id ?? "" } });
    const first = await feed(ana, "?limit=2");
    expect(first.items.map((item) => item.target.kind === "media" && item.target.mediaId)).toEqual([photos[2]?.id, photos[1]?.id]);
    expect(first.nextCursor).not.toBeNull();
    const second = await feed(ana, `?limit=2&cursor=${first.nextCursor ?? ""}`);
    expect(second.items.map((item) => item.target.kind === "media" && item.target.mediaId)).toEqual([photos[0]?.id]);
    expect(second.nextCursor).toBeNull();
    expect(first.items[0]).toMatchObject({
      kind: "photo_commented",
      actor: { name: "Bea Ríos Luna", avatarUrl: null },
      count: 1,
      seenAt: null,
      target: { kind: "media", place: { kind: "edition", year: 2026 } }
    });
    expect((await feed(bea)).items).toHaveLength(1);
    expect((await callAs(app, ana, "GET", "/api/notifications?cursor=bm9wZQ")).statusCode).toBe(400);
  });

  it("drops targets the recipient can no longer see (left event, lost album access, moderated photo) from the feed and the count", async () => {
    const ana = await eventActor();
    const bea = await eventActor();
    const trip = await insertEvent({ title: "Viaje a la sierra", organizerId: bea.user.id, visibility: "participants", participantIds: [ana.user.id] });
    const open = await insertEvent({ title: "Comida abierta", organizerId: bea.user.id });
    const albumPhoto = await insertAlbumMedia(trip.album, { uploadedByUserId: ana.user.id });
    const moderated = await editionPhoto(ana.user.id);
    await record({ recipientUserId: ana.user.id, actorUserId: bea.user.id, kind: NotificationKind.EventAdded, target: { eventId: trip.event.id } });
    await record({ recipientUserId: ana.user.id, actorUserId: bea.user.id, kind: NotificationKind.EventAdded, target: { eventId: open.event.id } });
    await record({ recipientUserId: ana.user.id, actorUserId: bea.user.id, kind: NotificationKind.PhotoLiked, target: { mediaId: albumPhoto.id } });
    await record({ recipientUserId: ana.user.id, actorUserId: bea.user.id, kind: NotificationKind.PhotoLiked, target: { mediaId: moderated.id } });
    const kinds = async (): Promise<string[]> =>
      (await feed(ana)).items.map((item) => (item.target.kind === "event" ? item.target.event.title : item.target.kind === "media" ? item.target.mediaId : ""));
    expect((await kinds()).sort()).toEqual([albumPhoto.id, moderated.id, "Comida abierta", "Viaje a la sierra"].sort());
    expect(await unread(ana)).toBe(4);
    const albumItem = (await feed(ana)).items.find((item) => item.target.kind === "media" && item.target.mediaId === albumPhoto.id);
    expect(albumItem?.target).toMatchObject({ place: { kind: "album", event: { id: trip.event.id, title: "Viaje a la sierra" } } });

    // Removed from the participants-only trip: the event and its album photo disappear (no trace).
    await getTestDb()
      .delete(eventParticipants)
      .where(and(eq(eventParticipants.eventId, trip.event.id), eq(eventParticipants.userId, ana.user.id)));
    // A photo hidden by moderation disappears too.
    await getTestDb().update(mediaItems).set({ moderationStatus: "hidden" }).where(eq(mediaItems.id, moderated.id));
    expect(await kinds()).toEqual(["Comida abierta"]);
    expect(await unread(ana)).toBe(1);
    const body = (await callAs(app, ana, "GET", "/api/notifications")).body;
    expect(body).not.toContain("Viaje a la sierra");
    expect(body).not.toContain(albumPhoto.id);
  });

  it("shows a resolved proposal only to its proposer and never a pending one", async () => {
    const ana = await eventActor();
    const admin = await eventActor({ role: "admin" });
    const [from, to] = await Promise.all([insertPerson(), insertPerson()]);
    const [proposal] = await getTestDb()
      .insert(treeLinkProposals)
      .values({ kind: "same_person", fromPersonId: from.id, toPersonId: to.id, proposedByUserId: ana.user.id })
      .returning();
    if (proposal === undefined) throw new Error("no proposal");
    await record({ recipientUserId: ana.user.id, actorUserId: admin.user.id, kind: NotificationKind.TreeProposalResolved, target: { proposalId: proposal.id } });
    expect((await feed(ana)).items).toEqual([]);
    await getTestDb()
      .update(treeLinkProposals)
      .set({ status: "rejected", resolvedAt: new Date(), resolutionNote: "Nota privada de prueba" })
      .where(eq(treeLinkProposals.id, proposal.id));
    const [item] = (await feed(ana)).items;
    expect(item?.target).toEqual({ kind: "proposal", proposalId: proposal.id, status: "rejected" });
    expect(JSON.stringify(item)).not.toContain("Nota privada");
  });

  it("gives event_added a Salir flag only while the recipient takes part and is not the last organizer", async () => {
    const ana = await eventActor();
    const bea = await eventActor();
    const { event } = await insertEvent({ organizerId: bea.user.id });
    const added = await callAs(app, bea, "POST", `/api/events/${event.id}/participants`, { userIds: [ana.user.id] });
    expect(added.statusCode, added.body).toBe(200);
    const [item] = (await feed(ana)).items;
    expect(item).toMatchObject({ kind: "event_added", target: { kind: "event", event: { id: event.id }, canLeave: true } });
    // Leaving retracts it; the organizer added herself (no self-notification).
    expect((await callAs(app, ana, "DELETE", `/api/events/${event.id}/participants/me`)).statusCode).toBe(204);
    expect((await feed(ana)).items).toEqual([]);
    expect((await feed(bea)).items).toEqual([]);
  });
});

describe("actor PII", () => {
  it("shows a listed actor's avatar, only the name once they become unlisted or disabled, and never an account id", async () => {
    const ana = await eventActor();
    const bea = await eventActor({ displayName: "Bea Ríos Luna" });
    await getTestDb()
      .update(profiles)
      .set({ avatarKey: `avatars/${bea.user.id}/${randomUUID()}-256.webp`, listedInDirectory: true })
      .where(eq(profiles.userId, bea.user.id));
    const photo = await editionPhoto(ana.user.id);
    await record({ recipientUserId: ana.user.id, actorUserId: bea.user.id, kind: NotificationKind.PhotoLiked, target: { mediaId: photo.id } });
    expect((await feed(ana)).items[0]?.actor?.avatarUrl).toEqual(expect.stringContaining("-64.webp"));

    await getTestDb().update(profiles).set({ listedInDirectory: false }).where(eq(profiles.userId, bea.user.id));
    const response = await callAs(app, ana, "GET", "/api/notifications");
    expect(notificationPageSchema.parse(response.json()).items[0]?.actor).toEqual({ name: "Bea Ríos Luna", avatarUrl: null });
    expect(response.body).not.toContain(bea.user.id);
    expect(response.body).not.toContain("avatars/");
  });
});

describe("POST /api/notifications/read", () => {
  it("marks only the caller's own ids (others ignored, no error) or all, and answers the new count", async () => {
    const ana = await eventActor();
    const bea = await eventActor();
    const photos = await editionPhotos(ana.user.id, 2);
    const ids: string[] = [];
    for (const photo of photos) {
      const id = await record({ recipientUserId: ana.user.id, actorUserId: bea.user.id, kind: NotificationKind.PhotoCommented, target: { mediaId: photo.id } });
      if (id !== null) ids.push(id);
    }
    const beas = await record({ recipientUserId: bea.user.id, actorUserId: ana.user.id, kind: NotificationKind.PhotoCommented, target: { mediaId: photos[0]?.id ?? "" } });
    const some = await callAs(app, ana, "POST", "/api/notifications/read", { ids: [ids[0], beas] });
    expect(some.statusCode, some.body).toBe(200);
    expect(unreadCountSchema.parse(some.json()).count).toBe(1);
    expect((await rowsOf(bea.user.id))[0]?.seenAt).toBeNull();
    const all = await callAs(app, ana, "POST", "/api/notifications/read", { all: true });
    expect(unreadCountSchema.parse(all.json()).count).toBe(0);
    expect(await unread(bea)).toBe(1);
    expect((await feed(ana, "?unread=true")).items).toEqual([]);
    expect((await callAs(app, ana, "POST", "/api/notifications/read", { all: false })).statusCode).toBe(400);
  });
});

describe("WebSocket push", () => {
  it("sends the notification frame to the recipient's own sockets only, after the commit", async () => {
    const ana = await createChatMember();
    const bea = await createChatMember({ displayName: "Bea Ríos Luna" });
    const caro = await createChatMember();
    const { event } = await insertEvent({ title: "Posada de prueba", organizerId: bea.user.id });
    const [anaWs, beaWs, caroWs] = await Promise.all([ana, bea, caro].map((member) => connectMember(app, member)));
    if (anaWs === undefined || beaWs === undefined || caroWs === undefined) throw new Error("connect");
    clients.push(anaWs, beaWs, caroWs);
    const added = await callAs(app, bea, "POST", `/api/events/${event.id}/participants`, { userIds: [ana.user.id] });
    expect(added.statusCode, added.body).toBe(200);
    const frame = await anaWs.waitFor(frameOf("notification"));
    expect(frame.notification).toMatchObject({ kind: "event_added", actor: { name: "Bea Ríos Luna" }, target: { event: { id: event.id } } });
    expect(frame.unreadCount).toBe(1);
    await sleep(50);
    expect(beaWs.ofType("notification")).toEqual([]);
    expect(caroWs.ofType("notification")).toEqual([]);
  });

  it("sends nothing for a row that is gone or no longer visible to the recipient", async () => {
    const ana = await createChatMember();
    const bea = await createChatMember();
    const trip = await insertEvent({ organizerId: bea.user.id, visibility: "participants" });
    const anaWs = await connectMember(app, ana);
    clients.push(anaWs);
    const id = await record({ recipientUserId: ana.user.id, actorUserId: bea.user.id, kind: NotificationKind.EventAdded, target: { eventId: trip.event.id } });
    await pushNotifications(app, [id ?? "", randomUUID()]);
    await sleep(50);
    expect(anaWs.ofType("notification")).toEqual([]);
  });
});
