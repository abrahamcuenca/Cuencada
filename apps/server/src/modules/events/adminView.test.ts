/**
 * `event.admin_viewed` (ADR 0001 §7, Security requirement 5) [SEC]: written
 * before the data, once per admin per event per hour (race-free), only for
 * non-participant admins on `participants` events, and the read fails when
 * the audit write fails.
 */
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestApp } from "../../../test/helpers/app.js";
import { type MutableClock, mutableClock } from "../../../test/helpers/cuencadas.js";
import { getTestDb } from "../../../test/helpers/db.js";
import { callAs, errorOf, eventActor, insertAlbumMedia, insertEvent } from "../../../test/helpers/events.js";
import { FakeStorage } from "../../../test/helpers/fakes.js";
import type { App } from "../../app.js";
import { auditLogs, eventAdminViews } from "../../db/schema/index.js";

let app: App;
let clock: MutableClock;

beforeEach(async () => {
  clock = mutableClock("2026-10-11T10:05:00.000Z");
  app = await createTestApp({ storage: new FakeStorage(), clock });
});

afterEach(async () => {
  await getTestDb().$client.unsafe("drop trigger if exists w53_fail_admin_view on audit_logs");
  await getTestDb().$client.unsafe("drop function if exists w53_fail_admin_view()");
  await app.close();
});

async function views(): Promise<Array<typeof auditLogs.$inferSelect>> {
  return getTestDb().select().from(auditLogs).where(eq(auditLogs.action, "event.admin_viewed"));
}

describe("event.admin_viewed", () => {
  it("records the first surface once per hour, again in the next hour, with ids only", async () => {
    const admin = await eventActor({ role: "admin" });
    const ana = await eventActor();
    const { event, album, roomId } = await insertEvent({ title: "Viaje privado", visibility: "participants", organizerId: ana.user.id });
    const media = await insertAlbumMedia(album, { uploadedByUserId: ana.user.id });

    expect((await callAs(app, admin, "GET", `/api/chat/rooms/${roomId}/messages`)).statusCode).toBe(200);
    expect((await callAs(app, admin, "GET", `/api/events/${event.year}/${event.slug}`)).statusCode).toBe(200);
    expect((await callAs(app, admin, "GET", `/api/events/${event.id}/albums/${album.id}/media`)).statusCode).toBe(200);
    expect((await callAs(app, admin, "GET", `/api/media/${media.id}`)).statusCode).toBe(200);
    const first = await views();
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ actorUserId: admin.user.id, entityType: "event", entityId: event.id, metadata: { surface: "chat" } });
    expect(JSON.stringify(first)).not.toContain("Viaje privado");

    clock.set("2026-10-11T11:00:01.000Z");
    expect((await callAs(app, admin, "GET", `/api/events/${event.id}/albums/${album.id}/media`)).statusCode).toBe(200);
    const second = await views();
    expect(second.map((row) => row.metadata)).toEqual([{ surface: "chat" }, { surface: "media" }]);
    // The dedupe table keeps only the current window for this admin.
    expect(await getTestDb().select().from(eventAdminViews).where(eq(eventAdminViews.adminUserId, admin.user.id))).toHaveLength(1);
  });

  it("is race-free: concurrent views in one hour write exactly one row", async () => {
    const admin = await eventActor({ role: "admin" });
    const { event } = await insertEvent({ visibility: "participants" });
    const responses = await Promise.all(
      Array.from({ length: 8 }, () => callAs(app, admin, "GET", `/api/events/${event.year}/${event.slug}`))
    );
    expect(responses.map((response) => response.statusCode)).toEqual(Array(8).fill(200));
    expect(await views()).toHaveLength(1);
  });

  it("is not recorded for members events, for admins who take part, nor for members", async () => {
    const admin = await eventActor({ role: "admin" });
    const ana = await eventActor();
    const open = await insertEvent({ organizerId: ana.user.id });
    const joined = await insertEvent({ visibility: "participants", organizerId: ana.user.id, participantIds: [admin.user.id] });
    const closed = await insertEvent({ visibility: "participants", organizerId: ana.user.id });
    await callAs(app, admin, "GET", `/api/events/${open.event.year}/${open.event.slug}`);
    await callAs(app, admin, "GET", `/api/events/${joined.event.year}/${joined.event.slug}`);
    await callAs(app, ana, "GET", `/api/events/${closed.event.year}/${closed.event.slug}`);
    expect(await views()).toEqual([]);
  });

  it("fails the read (500, no data) when the audit write fails", async () => {
    const admin = await eventActor({ role: "admin" });
    const { event, roomId } = await insertEvent({ title: "Viaje privado", visibility: "participants" });
    await getTestDb().$client.unsafe(`
      create function w53_fail_admin_view() returns trigger language plpgsql as $$
      begin
        if new.action = 'event.admin_viewed' then raise exception 'audit unavailable'; end if;
        return new;
      end $$`);
    await getTestDb().$client.unsafe(
      "create trigger w53_fail_admin_view before insert on audit_logs for each row execute function w53_fail_admin_view()"
    );
    for (const url of [`/api/events/${event.year}/${event.slug}`, `/api/chat/rooms/${roomId}/messages`]) {
      const response = await callAs(app, admin, "GET", url);
      expect(response.statusCode).toBe(500);
      expect(errorOf(response.body).code).toBe("INTERNAL");
      expect(response.body).not.toContain("Viaje privado");
    }
    // The dedupe key rolled back with the failed audit: the next view (audit back) is recorded.
    expect(
      await getTestDb().select().from(eventAdminViews).where(and(eq(eventAdminViews.adminUserId, admin.user.id), eq(eventAdminViews.eventId, event.id)))
    ).toEqual([]);
  });
});
