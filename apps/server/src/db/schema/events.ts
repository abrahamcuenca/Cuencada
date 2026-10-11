/**
 * Eventos (WP-5.2, migration 0007/0008 `events`): family events with
 * participants, albums and a 16:9 cover. The event chat room lives in
 * `chat_rooms` (`kind = 'event'`, `event_id`), album media in `media_items`
 * (`album_id`). Authorization: ADR 0001 §7.
 */
import {
  AVATAR_MAX_BYTES,
  EVENT_ALBUM_SORT_ORDER_MAX,
  EVENT_ALBUM_TITLE_MAX_LENGTH,
  EVENT_DETAILS_MAX_LENGTH,
  EVENT_LOCATION_MAX_LENGTH,
  EVENT_SLUG_MAX_LENGTH,
  EVENT_SLUG_MIN_LENGTH,
  EVENT_SLUG_PATTERN,
  EVENT_SUMMARY_MAX_LENGTH,
  EVENT_TITLE_MAX_LENGTH,
  EventRole,
  EventStatus,
  EventVisibility,
  avatarMimeTypeSchema
} from "@cuencada/types";
import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, primaryKey, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { users } from "./auth.js";
import { checkIn, createdAt, inList, timestamptz, updatedAt } from "./helpers.js";
import type { AvatarMimeType } from "./profiles.js";

export const events = pgTable(
  "events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    /** URL slug, unique per year (`/eventos/{year}/{slug}`). */
    slug: text("slug").notNull(),
    /** The year of `starts_at` in `timezone` when dated (CHECK), else chosen explicitly. */
    year: integer("year").notNull(),
    title: text("title").notNull(),
    summary: text("summary"),
    details: text("details"),
    /** Both or neither, like Cuencadas (`events_dates_check`). */
    startsAt: timestamptz("starts_at"),
    endsAt: timestamptz("ends_at"),
    timezone: text("timezone").notNull().default("America/Merida"),
    locationText: text("location_text"),
    /** Upload id of the current cover; keys `events/{id}/cover/{coverKey}-{1280|640}.webp`. */
    coverKey: text("cover_key"),
    coverUpdatedAt: timestamptz("cover_updated_at"),
    visibility: text("visibility").$type<EventVisibility>().notNull().default("members"),
    status: text("status").$type<EventStatus>().notNull().default("draft"),
    /** Set on the first publish and never cleared. */
    firstPublishedAt: timestamptz("first_published_at"),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  },
  (table) => [
    uniqueIndex("events_year_slug_unique").on(table.year, table.slug),
    // List keyset: `order by year, starts_at, id` (asc for upcoming, desc for past).
    index("events_year_starts_at_idx").on(table.year, table.startsAt, table.id),
    index("events_created_by_user_id_idx").on(table.createdByUserId),
    check(
      "events_slug_check",
      sql.raw(
        `char_length("slug") between ${EVENT_SLUG_MIN_LENGTH} and ${EVENT_SLUG_MAX_LENGTH} and "slug" ~ '${EVENT_SLUG_PATTERN}'`
      )
    ),
    check("events_year_range_check", sql`"year" between 1900 and 2200`),
    check(
      "events_dates_check",
      sql`("starts_at" is null and "ends_at" is null) or ("starts_at" is not null and "ends_at" is not null and "ends_at" > "starts_at")`
    ),
    check(
      "events_year_check",
      sql`"starts_at" is null or "year" = extract(year from ("starts_at" at time zone "timezone"))::integer`
    ),
    check("events_title_length_check", sql.raw(`char_length("title") between 1 and ${EVENT_TITLE_MAX_LENGTH}`)),
    check(
      "events_summary_length_check",
      sql.raw(`"summary" is null or char_length("summary") <= ${EVENT_SUMMARY_MAX_LENGTH}`)
    ),
    check(
      "events_details_length_check",
      sql.raw(`"details" is null or char_length("details") <= ${EVENT_DETAILS_MAX_LENGTH}`)
    ),
    check(
      "events_location_text_length_check",
      sql.raw(`"location_text" is null or char_length("location_text") <= ${EVENT_LOCATION_MAX_LENGTH}`)
    ),
    check("events_cover_check", sql`("cover_key" is null) = ("cover_updated_at" is null)`),
    checkIn("events_visibility_check", "visibility", EventVisibility),
    checkIn("events_status_check", "status", EventStatus),
    check("events_published_check", sql`"status" <> 'published' or "first_published_at" is not null`)
  ]
);

/**
 * Who takes part. Organizers manage the event. A user delete removes their
 * rows (an event may then have no organizer; admins still manage it).
 */
export const eventParticipants = pgTable(
  "event_participants",
  {
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role").$type<EventRole>().notNull().default("participant"),
    /** Who added them; `null` for a self-join or once that account is removed. */
    addedByUserId: uuid("added_by_user_id").references(() => users.id, { onDelete: "set null" }),
    joinedAt: timestamptz("joined_at").notNull().defaultNow()
  },
  (table) => [
    primaryKey({ name: "event_participants_pkey", columns: [table.eventId, table.userId] }),
    index("event_participants_user_id_idx").on(table.userId),
    index("event_participants_added_by_user_id_idx").on(table.addedByUserId),
    checkIn("event_participants_role_check", "role", EventRole)
  ]
);

/**
 * Photo albums of an event (a default "Fotos" album is created with it).
 * `media_items.album_id` references this table with ON DELETE RESTRICT: an
 * album (and so an event) cannot be deleted while media rows, even
 * soft-deleted ones, point at it; the service removes them first.
 */
export const eventAlbums = pgTable(
  "event_albums",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  },
  (table) => [
    index("event_albums_event_id_idx").on(table.eventId, table.sortOrder),
    index("event_albums_created_by_user_id_idx").on(table.createdByUserId),
    check("event_albums_title_length_check", sql.raw(`char_length("title") between 1 and ${EVENT_ALBUM_TITLE_MAX_LENGTH}`)),
    check("event_albums_sort_order_check", sql.raw(`"sort_order" between 0 and ${EVENT_ALBUM_SORT_ORDER_MAX}`))
  ]
);

/** Pending cover uploads (mirrors `person_photo_uploads`). */
export const eventCoverUploads = pgTable(
  "event_cover_uploads",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    uploadedByUserId: uuid("uploaded_by_user_id").references(() => users.id, { onDelete: "set null" }),
    objectKey: text("object_key").notNull(),
    mimeType: text("mime_type").$type<AvatarMimeType>().notNull(),
    byteSize: integer("byte_size").notNull(),
    expiresAt: timestamptz("expires_at").notNull(),
    confirmedAt: timestamptz("confirmed_at"),
    createdAt: createdAt()
  },
  (table) => [
    uniqueIndex("event_cover_uploads_object_key_unique").on(table.objectKey),
    index("event_cover_uploads_event_id_idx").on(table.eventId),
    index("event_cover_uploads_uploaded_by_user_id_idx").on(table.uploadedByUserId),
    check("event_cover_uploads_mime_type_check", inList("mime_type", avatarMimeTypeSchema.options)),
    check("event_cover_uploads_byte_size_check", sql.raw(`"byte_size" > 0 and "byte_size" <= ${AVATAR_MAX_BYTES}`))
  ]
);
