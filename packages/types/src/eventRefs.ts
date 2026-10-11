/**
 * Small references to events and event albums embedded in other modules'
 * read models (`ChatRoom.event`, `MediaItem.album`/`event`), WP-5.2.
 *
 * A leaf module on purpose: it imports only `common.ts`, so `chat.ts` and
 * `media.ts` can use it without an import cycle through `events.ts` (which
 * imports `profile.ts`, which imports `media.ts`). Re-exported by `events.ts`.
 */
import { z } from "zod";
import { idSchema, yearSchema } from "./common.js";

/** Longest event title (DB CHECK `events_title_length_check`). */
export const EVENT_TITLE_MAX_LENGTH = 120;
/** Longest album title (DB CHECK `event_albums_title_length_check`). */
export const EVENT_ALBUM_TITLE_MAX_LENGTH = 80;
/** Shortest and longest event slug (DB CHECK `events_slug_check`). */
export const EVENT_SLUG_MIN_LENGTH = 3;
export const EVENT_SLUG_MAX_LENGTH = 60;

/**
 * Enough to link to an event: `/eventos/{year}/{slug}`. Only ever sent to a
 * viewer who may see the event (ADR 0001 §7).
 */
export interface EventRef {
  id: string;
  year: number;
  slug: string;
  title: string;
}

export const eventRefSchema = z.object({
  id: idSchema,
  year: yearSchema,
  slug: z.string().max(EVENT_SLUG_MAX_LENGTH),
  title: z.string().max(EVENT_TITLE_MAX_LENGTH)
}) satisfies z.ZodType<EventRef>;

/** The album an event media item belongs to. */
export interface MediaAlbumRef {
  id: string;
  title: string;
  eventId: string;
}

export const mediaAlbumRefSchema = z.object({
  id: idSchema,
  title: z.string().max(EVENT_ALBUM_TITLE_MAX_LENGTH),
  eventId: idSchema
}) satisfies z.ZodType<MediaAlbumRef>;
