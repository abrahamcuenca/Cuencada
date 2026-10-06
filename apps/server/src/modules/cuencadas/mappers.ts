/**
 * DB row → contract mappers for Cuencadas and their content. Response schemas
 * strip anything extra, but these mappers already build exactly the contract
 * shape so a members-only column can never leak by accident.
 */
import type {
  AdminCuencada,
  Announcement,
  CuencadaSummary,
  DailyMessage,
  ItineraryItem,
  LocationItem,
  PublicCuencada
} from "@cuencada/types";
import type { cuencadaItineraryItems, cuencadaLocations, cuencadas, dailyMessages } from "../../db/schema/index.js";
import { computeCuencadaStatus } from "./status.js";

export type CuencadaRow = typeof cuencadas.$inferSelect;
export type ItineraryRow = typeof cuencadaItineraryItems.$inferSelect;
export type LocationRow = typeof cuencadaLocations.$inferSelect;
export type DailyMessageRow = typeof dailyMessages.$inferSelect;

/** postgres-js returns `time` as `HH:MM:SS`; the contract is `HH:MM`. */
function toHhMm(value: string | null): string | null {
  return value === null ? null : value.slice(0, 5);
}

function isoOrNull(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

/** @param row - Itinerary row. */
export function toItineraryItem(row: ItineraryRow): ItineraryItem {
  return {
    id: row.id,
    date: row.date,
    startTime: toHhMm(row.startTime),
    endTime: toHhMm(row.endTime),
    title: row.title,
    description: row.description,
    locationName: row.locationName,
    locationId: row.locationId,
    priceNote: row.priceNote,
    tags: row.tags,
    visibility: row.visibility,
    sortOrder: row.sortOrder
  };
}

/** @param row - Location row. */
export function toLocationItem(row: LocationRow): LocationItem {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    description: row.description,
    address: row.address,
    url: row.url,
    mapsUrl: row.mapsUrl,
    lat: row.lat,
    lng: row.lng,
    visibility: row.visibility,
    sortOrder: row.sortOrder
  };
}

/** @param row - Daily message row. */
export function toDailyMessage(row: Pick<DailyMessageRow, "id" | "date" | "message">): DailyMessage {
  return { id: row.id, date: row.date, message: row.message };
}

/**
 * Card for lists.
 *
 * @param row - Cuencada row.
 * @param hasMedia - At least one visible gallery item (media module's `countVisibleMediaByCuencada`).
 * @param now - Current instant for the status.
 */
export function toCuencadaSummary(row: CuencadaRow, hasMedia: boolean, now: Date): CuencadaSummary {
  return {
    id: row.id,
    year: row.year,
    slug: row.slug,
    title: row.title,
    status: computeCuencadaStatus(row, now),
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt.toISOString(),
    timezone: row.timezone,
    city: row.city,
    state: row.state,
    heroImageUrl: row.heroImageUrl,
    themeColor: row.themeColor,
    hasMedia
  };
}

/** Public scalar fields shared by the public and admin shapes (no member-only links). */
function publicScalars(row: CuencadaRow, now: Date): Omit<AdminCuencada, "isPublished" | "whatsappUrl" | "externalAlbumUrl" | "createdAt" | "updatedAt"> {
  return {
    id: row.id,
    year: row.year,
    slug: row.slug,
    title: row.title,
    status: computeCuencadaStatus(row, now),
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt.toISOString(),
    timezone: row.timezone,
    city: row.city,
    state: row.state,
    country: row.country,
    description: row.description,
    heroImageUrl: row.heroImageUrl,
    themeColor: row.themeColor,
    songUrl: row.songUrl,
    weatherWidgetUrl: row.weatherWidgetUrl,
    rsvpDeadline: isoOrNull(row.rsvpDeadline)
  };
}

/** Public content lists of one edition. */
export interface PublicContent {
  itinerary: ItineraryItem[];
  locations: LocationItem[];
  announcements: Announcement[];
  todayMessage: DailyMessage | null;
}

/**
 * Anonymous view. Never includes `whatsappUrl`/`externalAlbumUrl`; callers
 * pass only public items.
 *
 * @param row - Cuencada row.
 * @param content - Public-only lists and today's message.
 * @param now - Current instant for the status.
 */
export function toPublicCuencada(row: CuencadaRow, content: PublicContent, now: Date): PublicCuencada {
  return {
    ...publicScalars(row, now),
    publicItinerary: content.itinerary,
    publicLocations: content.locations,
    publicAnnouncements: content.announcements,
    todayMessage: content.todayMessage
  };
}

/**
 * Admin view (every column).
 *
 * @param row - Cuencada row.
 * @param now - Current instant for the status.
 */
export function toAdminCuencada(row: CuencadaRow, now: Date): AdminCuencada {
  return {
    ...publicScalars(row, now),
    isPublished: row.isPublished,
    whatsappUrl: row.whatsappUrl,
    externalAlbumUrl: row.externalAlbumUrl,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  };
}
