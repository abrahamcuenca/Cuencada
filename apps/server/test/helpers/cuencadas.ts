/**
 * Test fixtures for Cuencada content (T2): direct inserts into the worker
 * database plus a controllable clock.
 */
import { randomUUID } from "node:crypto";
import type { Clock } from "../../src/lib/clock.js";
import {
  announcements,
  cuencadaItineraryItems,
  cuencadaLocations,
  cuencadas,
  dailyMessages,
  mediaItems
} from "../../src/db/schema/index.js";
import { getTestDb } from "./db.js";

type CuencadaInsert = typeof cuencadas.$inferInsert;
type CuencadaRow = typeof cuencadas.$inferSelect;

/** A clock whose time tests can move. */
export interface MutableClock extends Clock {
  set(iso: string): void;
}

/**
 * @param iso - Initial instant.
 */
export function mutableClock(iso: string): MutableClock {
  let current = new Date(iso);
  return {
    now: () => new Date(current.getTime()),
    set: (value) => {
      current = new Date(value);
    }
  };
}

/**
 * Insert a Cuencada. Defaults: published, Mérida, 13–18 Sep of `year`, with
 * member-only links set so tests can assert they never leak.
 *
 * @param overrides - Columns to replace; `year` drives slug and dates.
 */
export async function insertCuencada(overrides: Partial<CuencadaInsert> = {}): Promise<CuencadaRow> {
  const year = overrides.year ?? 2026;
  const [row] = await getTestDb()
    .insert(cuencadas)
    .values({
      year,
      slug: String(year),
      title: `Cuencada ${year}`,
      startsAt: new Date(`${year}-09-13T00:00:00-06:00`),
      endsAt: new Date(`${year}-09-18T23:59:59-06:00`),
      timezone: "America/Merida",
      city: "Mérida",
      state: "Yucatán",
      description: "Reunión familiar.",
      whatsappUrl: "https://chat.whatsapp.com/SECRETO",
      externalAlbumUrl: "https://onedrive.live.com/album-secreto",
      isPublished: true,
      ...overrides
    })
    .returning();
  if (row === undefined) throw new Error("insertCuencada: no row");
  return row;
}

/**
 * Insert an announced edition (WP-3.1a): published, no dates and no place yet.
 *
 * @param year - Edition year (default 2027).
 * @param overrides - Columns to replace.
 */
export async function insertAnnouncedCuencada(
  year = 2027,
  overrides: Partial<CuencadaInsert> = {}
): Promise<CuencadaRow> {
  return insertCuencada({
    year,
    startsAt: null,
    endsAt: null,
    city: null,
    state: null,
    description: "Fecha y lugar por anunciar.",
    firstPublishedAt: new Date(`${year - 1}-10-01T12:00:00Z`),
    ...overrides
  });
}

/** Insert a location. */
export async function insertLocation(
  cuencadaId: string,
  overrides: Partial<typeof cuencadaLocations.$inferInsert> = {}
): Promise<typeof cuencadaLocations.$inferSelect> {
  const [row] = await getTestDb()
    .insert(cuencadaLocations)
    .values({ cuencadaId, name: `Lugar ${randomUUID().slice(0, 8)}`, kind: "venue", ...overrides })
    .returning();
  if (row === undefined) throw new Error("insertLocation: no row");
  return row;
}

/** Insert an itinerary item. */
export async function insertItineraryItem(
  cuencadaId: string,
  overrides: Partial<typeof cuencadaItineraryItems.$inferInsert> = {}
): Promise<typeof cuencadaItineraryItems.$inferSelect> {
  const [row] = await getTestDb()
    .insert(cuencadaItineraryItems)
    .values({ cuencadaId, date: "2026-09-13", title: "Actividad", ...overrides })
    .returning();
  if (row === undefined) throw new Error("insertItineraryItem: no row");
  return row;
}

/** Insert an announcement (`cuencadaId: null` = portal-wide). */
export async function insertAnnouncement(
  overrides: Partial<typeof announcements.$inferInsert> = {}
): Promise<typeof announcements.$inferSelect> {
  const [row] = await getTestDb()
    .insert(announcements)
    .values({ title: "Aviso", body: "Texto del aviso.", visibility: "public", publishAt: new Date("2020-01-01T00:00:00Z"), ...overrides })
    .returning();
  if (row === undefined) throw new Error("insertAnnouncement: no row");
  return row;
}

/** Insert a daily message. */
export async function insertDailyMessage(cuencadaId: string, date: string, message: string): Promise<void> {
  await getTestDb().insert(dailyMessages).values({ cuencadaId, date, message });
}

/** Insert a gallery item (defaults: ready, approved, not deleted). */
export async function insertMedia(
  cuencadaId: string,
  overrides: Partial<typeof mediaItems.$inferInsert> = {}
): Promise<void> {
  const key = randomUUID();
  await getTestDb()
    .insert(mediaItems)
    .values({
      cuencadaId,
      kind: "image",
      objectKey: `cuencadas/test/${key}.jpg`,
      bucket: "test-bucket",
      fileName: "foto.jpg",
      mimeType: "image/jpeg",
      byteSize: 1000,
      uploadStatus: "ready",
      moderationStatus: "approved",
      ...overrides
    });
}
