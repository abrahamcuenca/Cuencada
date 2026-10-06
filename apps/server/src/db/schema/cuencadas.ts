/**
 * Cuencada editions and their content: locations, itinerary, daily messages
 * and announcements. Edition status (`draft`/`upcoming`/`active`/`past`) is
 * computed from `is_published` and the dates, never stored.
 */
import { DAILY_MESSAGE_MAX_LENGTH, LocationKind, Visibility } from "@cuencada/types";
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  doublePrecision,
  index,
  integer,
  pgTable,
  text,
  time,
  uniqueIndex,
  uuid
} from "drizzle-orm/pg-core";
import { users } from "./auth.js";
import { checkIn, createdAt, timestamptz, updatedAt } from "./helpers.js";

export const cuencadas = pgTable(
  "cuencadas",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    year: integer("year").notNull().unique(),
    slug: text("slug").notNull().unique(),
    title: text("title").notNull(),
    startsAt: timestamptz("starts_at").notNull(),
    endsAt: timestamptz("ends_at").notNull(),
    /** IANA zone for status, countdown, itinerary dates and daily messages. */
    timezone: text("timezone").notNull().default("America/Merida"),
    city: text("city").notNull(),
    state: text("state").notNull(),
    country: text("country").notNull().default("México"),
    description: text("description").notNull(),
    heroImageUrl: text("hero_image_url"),
    themeColor: text("theme_color").notNull().default("#0b5e55"),
    songUrl: text("song_url"),
    /** Member-only: the group invite link is effectively a credential. */
    whatsappUrl: text("whatsapp_url"),
    weatherWidgetUrl: text("weather_widget_url"),
    /** Member-only shared album (legacy OneDrive folder). */
    externalAlbumUrl: text("external_album_url"),
    rsvpDeadline: timestamptz("rsvp_deadline"),
    isPublished: boolean("is_published").notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  },
  (table) => [
    index("cuencadas_published_starts_at_idx").on(table.isPublished, table.startsAt),
    check("cuencadas_year_check", sql`"year" between 1900 and 2200`),
    check("cuencadas_dates_check", sql`"ends_at" > "starts_at"`),
    check("cuencadas_theme_color_check", sql`"theme_color" ~ '^#[0-9a-f]{6}$'`)
  ]
);

export const cuencadaLocations = pgTable(
  "cuencada_locations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    cuencadaId: uuid("cuencada_id")
      .notNull()
      .references(() => cuencadas.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    kind: text("kind").$type<LocationKind>().notNull().default("other"),
    description: text("description"),
    address: text("address"),
    /** Official website / booking link. */
    url: text("url"),
    mapsUrl: text("maps_url"),
    lat: doublePrecision("lat"),
    lng: doublePrecision("lng"),
    visibility: text("visibility").$type<Visibility>().notNull().default("public"),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  },
  (table) => [
    index("cuencada_locations_cuencada_sort_idx").on(table.cuencadaId, table.sortOrder),
    checkIn("cuencada_locations_kind_check", "kind", LocationKind),
    checkIn("cuencada_locations_visibility_check", "visibility", Visibility),
    check("cuencada_locations_lat_check", sql`"lat" is null or "lat" between -90 and 90`),
    check("cuencada_locations_lng_check", sql`"lng" is null or "lng" between -180 and 180`),
    check("cuencada_locations_lat_lng_pair_check", sql`("lat" is null) = ("lng" is null)`)
  ]
);

/**
 * One programa entry. `date` is a calendar day in the Cuencada's timezone and
 * the times are wall-clock (`time`, returned by postgres-js as `HH:MM:SS`).
 * `location_id` must belong to the same Cuencada; the service enforces that.
 */
export const cuencadaItineraryItems = pgTable(
  "cuencada_itinerary_items",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    cuencadaId: uuid("cuencada_id")
      .notNull()
      .references(() => cuencadas.id, { onDelete: "cascade" }),
    date: date("date").notNull(),
    startTime: time("start_time"),
    endTime: time("end_time"),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    locationName: text("location_name"),
    locationId: uuid("location_id").references(() => cuencadaLocations.id, { onDelete: "set null" }),
    /** Display-only text such as "$1,000 p/p"; never used for arithmetic. */
    priceNote: text("price_note"),
    visibility: text("visibility").$type<Visibility>().notNull().default("public"),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  },
  (table) => [
    index("cuencada_itinerary_items_cuencada_date_sort_idx").on(table.cuencadaId, table.date, table.sortOrder),
    index("cuencada_itinerary_items_location_id_idx").on(table.locationId),
    checkIn("cuencada_itinerary_items_visibility_check", "visibility", Visibility),
    check(
      "cuencada_itinerary_items_time_order_check",
      sql`"start_time" is null or "end_time" is null or "end_time" > "start_time"`
    )
  ]
);

/** Message of the day (legacy `mensajes.txt`), one per Cuencada and date. */
export const dailyMessages = pgTable(
  "daily_messages",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    cuencadaId: uuid("cuencada_id")
      .notNull()
      .references(() => cuencadas.id, { onDelete: "cascade" }),
    date: date("date").notNull(),
    message: text("message").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  },
  (table) => [
    uniqueIndex("daily_messages_cuencada_date_unique").on(table.cuencadaId, table.date),
    check(
      "daily_messages_message_length_check",
      sql.raw(`char_length("message") between 1 and ${DAILY_MESSAGE_MAX_LENGTH}`)
    )
  ]
);

/** Announcement; `cuencada_id` null means portal-wide. */
export const announcements = pgTable(
  "announcements",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    cuencadaId: uuid("cuencada_id").references(() => cuencadas.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    body: text("body").notNull(),
    visibility: text("visibility").$type<Visibility>().notNull().default("members"),
    pinned: boolean("pinned").notNull().default(false),
    /** Contract `publishedAt`; future values schedule the announcement. */
    publishAt: timestamptz("publish_at").notNull().defaultNow(),
    expiresAt: timestamptz("expires_at"),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  },
  (table) => [
    index("announcements_cuencada_publish_at_idx").on(table.cuencadaId, table.publishAt.desc()),
    index("announcements_created_by_user_id_idx").on(table.createdByUserId),
    checkIn("announcements_visibility_check", "visibility", Visibility),
    check("announcements_expiry_check", sql`"expires_at" is null or "expires_at" > "publish_at"`)
  ]
);
