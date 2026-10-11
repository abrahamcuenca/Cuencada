/**
 * Event fixtures (WP-5.3): rows inserted straight into the worker database
 * (fictional titles only; the repository is public).
 */
import { randomUUID } from "node:crypto";
import { type EventRole, type EventStatus, type EventVisibility, memberEventSlug } from "@cuencada/types";
import { chatRooms, eventAlbums, eventParticipants, events, mediaItems } from "../../src/db/schema/index.js";
import { getTestDb } from "./db.js";

type EventRow = typeof events.$inferSelect;
type AlbumRow = typeof eventAlbums.$inferSelect;
type MediaInsert = typeof mediaItems.$inferInsert;
type MediaRow = typeof mediaItems.$inferSelect;

/** Options of {@link insertEvent}. */
export interface InsertEventOptions {
  title?: string;
  year?: number;
  slug?: string;
  status?: EventStatus;
  visibility?: EventVisibility;
  /** The organizer (also `created_by_user_id`); `null` for none. */
  organizerId?: string | null;
  /** Extra participants (role `participant`, added by the organizer). */
  participantIds?: readonly string[];
  /** Create the chat room (default: when published). */
  withRoom?: boolean;
  startsAt?: Date | null;
  endsAt?: Date | null;
}

/** An inserted event with its default album and (optionally) its room. */
export interface TestEvent {
  event: EventRow;
  album: AlbumRow;
  roomId: string | null;
}

/**
 * Insert an event, its organizer and participants, a "Fotos" album and,
 * when published (or asked), its chat room.
 */
export async function insertEvent(options: InsertEventOptions = {}): Promise<TestEvent> {
  const db = getTestDb();
  const status = options.status ?? "published";
  const title = options.title ?? "Comida en el rancho";
  const organizerId = options.organizerId ?? null;
  const [event] = await db
    .insert(events)
    .values({
      title,
      slug: options.slug ?? memberEventSlug(title),
      year: options.year ?? 2026,
      startsAt: options.startsAt ?? null,
      endsAt: options.endsAt ?? null,
      status,
      visibility: options.visibility ?? "members",
      firstPublishedAt: status === "published" ? new Date() : null,
      createdByUserId: organizerId
    })
    .returning();
  if (event === undefined) throw new Error("insertEvent: no row");
  if (organizerId !== null) await addParticipant(event.id, organizerId, "organizer", null);
  for (const userId of options.participantIds ?? []) await addParticipant(event.id, userId, "participant", organizerId);
  const [album] = await db.insert(eventAlbums).values({ eventId: event.id, title: "Fotos" }).returning();
  if (album === undefined) throw new Error("insertEvent: no album");
  let roomId: string | null = null;
  if (options.withRoom ?? status === "published") {
    const [room] = await db.insert(chatRooms).values({ kind: "event", eventId: event.id }).returning({ id: chatRooms.id });
    roomId = room?.id ?? null;
  }
  return { event, album, roomId };
}

/** Add a participant row. */
export async function addParticipant(
  eventId: string,
  userId: string,
  role: EventRole = "participant",
  addedByUserId: string | null = null
): Promise<void> {
  await getTestDb().insert(eventParticipants).values({ eventId, userId, role, addedByUserId });
}

/**
 * Insert a media row in an album (prefix and keys under
 * `events/{eventId}/{albumId}`; ready and approved by default).
 */
export async function insertAlbumMedia(album: Pick<AlbumRow, "id" | "eventId">, values: Partial<MediaInsert> = {}): Promise<MediaRow> {
  const id = values.id ?? randomUUID();
  const prefix = `events/${album.eventId}/${album.id}`;
  const [row] = await getTestDb()
    .insert(mediaItems)
    .values({
      id,
      cuencadaId: null,
      albumId: album.id,
      storagePrefix: prefix,
      kind: "image",
      objectKey: `${prefix}/originals/${id}.jpg`,
      thumbKey: `${prefix}/thumbs/${id}.webp`,
      displayKey: `${prefix}/display/${id}.webp`,
      bucket: "test-bucket",
      fileName: "foto.jpg",
      mimeType: "image/jpeg",
      byteSize: 1000,
      width: 1600,
      height: 1200,
      uploadStatus: "ready",
      moderationStatus: "approved",
      ...values
    })
    .returning();
  if (row === undefined) throw new Error("insertAlbumMedia: no row");
  return row;
}
