/**
 * Cuencada editions and their content: itinerary, locations, daily messages
 * and announcements. Public reads are cacheable (PWA NetworkFirst); member
 * reads require login.
 */
import { z } from "zod";
import {
  API_ERROR_DETAILS_MAX,
  type ApiErrorDetail,
  assetUrlSchema,
  dateSchema,
  dateTimeSchema,
  hexColorSchema,
  httpsUrlSchema,
  idSchema,
  nullableTextSchema,
  requiredTextSchema,
  timeSchema,
  timezoneSchema,
  Visibility,
  visibilitySchema,
  yearSchema
} from "./common.js";
import { hasUnsafeChars } from "./common.js";

/* -------------------------------------------------------------------------- */
/* Enums                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Computed (never stored) from `isPublished`, `startsAt`, `endsAt` and now, in
 * the Cuencada's timezone: unpublished → `draft`; before start → `upcoming`;
 * between start and end → `active`; after end → `past`.
 */
export const CuencadaStatus = {
  Draft: "draft",
  Upcoming: "upcoming",
  Active: "active",
  Past: "past"
} as const;
export type CuencadaStatus = (typeof CuencadaStatus)[keyof typeof CuencadaStatus];
export const cuencadaStatusSchema = z.enum(CuencadaStatus);

export const LocationKind = {
  Hotel: "hotel",
  Venue: "venue",
  Attraction: "attraction",
  Other: "other"
} as const;
export type LocationKind = (typeof LocationKind)[keyof typeof LocationKind];
export const locationKindSchema = z.enum(LocationKind);

/** What the home page shows: the next edition's hero or "memories" of the last one. */
export const HomeMode = {
  Upcoming: "upcoming",
  Active: "active",
  Memories: "memories"
} as const;
export type HomeMode = (typeof HomeMode)[keyof typeof HomeMode];
export const homeModeSchema = z.enum(HomeMode);

/* -------------------------------------------------------------------------- */
/* Content items                                                               */
/* -------------------------------------------------------------------------- */

/** One entry of the programa. */
export interface ItineraryItem {
  id: string;
  /** Day, `YYYY-MM-DD`, in the Cuencada's timezone. */
  date: string;
  /** `HH:MM` 24h, or `null` for all-day items. */
  startTime: string | null;
  endTime: string | null;
  title: string;
  description: string;
  locationName: string | null;
  /** Optional link to a `LocationItem` of the same Cuencada. */
  locationId: string | null;
  /** Free text such as "$1,000 p/p". Display only; never used for arithmetic. */
  priceNote: string | null;
  /**
   * Short labels such as "Incluye comida" (WP-2.1). At most
   * {@link ITINERARY_TAGS_MAX}, each 1–{@link ITINERARY_TAG_MAX_LENGTH} chars.
   */
  tags: string[];
  visibility: Visibility;
  sortOrder: number;
}

/** Maximum number of tags on one itinerary item (DB CHECK `cardinality(tags) <= 6`). */
export const ITINERARY_TAGS_MAX = 6;
/** Maximum length of one itinerary tag, after trimming. */
export const ITINERARY_TAG_MAX_LENGTH = 24;

/**
 * One itinerary tag on input: NFC-normalized, trimmed, 1–24 characters, and
 * rejecting bidi controls and invisible characters (see `hasUnsafeChars`), so
 * a tag can never be blank-looking, reversed or a lookalike of another.
 */
export const itineraryTagSchema = z
  .string()
  .normalize("NFC")
  .trim()
  .min(1, { error: "La etiqueta no puede estar vacía." })
  .max(ITINERARY_TAG_MAX_LENGTH, { error: `Cada etiqueta admite hasta ${ITINERARY_TAG_MAX_LENGTH} caracteres.` })
  .refine((value) => !hasUnsafeChars(value), { error: "La etiqueta contiene caracteres no permitidos." });

/**
 * Drops tags that repeat an earlier one case-insensitively (`Comida` and
 * `comida`), keeping the first spelling and the original order.
 */
function dedupeTags(tags: string[]): string[] {
  const seen = new Set<string>();
  return tags.filter((tag) => {
    const key = tag.toLocaleLowerCase("es");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Itinerary tags on input: each validated by {@link itineraryTagSchema},
 * de-duplicated case-insensitively, then at most {@link ITINERARY_TAGS_MAX}.
 */
export const itineraryTagsSchema = z
  .array(itineraryTagSchema)
  // Raw bound before de-duplication: ×4 leaves room for case-insensitive
  // repeats (`Comida`, `comida`, …) that collapse below the real limit, while
  // still capping the work `dedupeTags` does on a hostile payload (24 items).
  .max(ITINERARY_TAGS_MAX * 4, { error: `Máximo ${ITINERARY_TAGS_MAX} etiquetas.` })
  .transform(dedupeTags)
  .pipe(z.array(z.string()).max(ITINERARY_TAGS_MAX, { error: `Máximo ${ITINERARY_TAGS_MAX} etiquetas.` }));

export const itineraryItemSchema = z.object({
  id: idSchema,
  date: dateSchema,
  startTime: timeSchema.nullable(),
  endTime: timeSchema.nullable(),
  title: z.string().max(200),
  description: z.string().max(2000),
  locationName: z.string().max(200).nullable(),
  locationId: idSchema.nullable(),
  priceNote: z.string().max(120).nullable(),
  tags: z.array(z.string().max(ITINERARY_TAG_MAX_LENGTH)).max(ITINERARY_TAGS_MAX),
  visibility: visibilitySchema,
  sortOrder: z.number().int()
}) satisfies z.ZodType<ItineraryItem>;

/** A hotel, venue or attraction. */
export interface LocationItem {
  id: string;
  name: string;
  kind: LocationKind;
  description: string | null;
  address: string | null;
  /** Official website / booking link. */
  url: string | null;
  /** Google Maps link. */
  mapsUrl: string | null;
  lat: number | null;
  lng: number | null;
  visibility: Visibility;
  sortOrder: number;
}

export const locationItemSchema = z.object({
  id: idSchema,
  name: z.string().max(200),
  kind: locationKindSchema,
  description: z.string().max(2000).nullable(),
  address: z.string().max(300).nullable(),
  url: z.string().max(2048).nullable(),
  mapsUrl: z.string().max(2048).nullable(),
  lat: z.number().min(-90).max(90).nullable(),
  lng: z.number().min(-180).max(180).nullable(),
  visibility: visibilitySchema,
  sortOrder: z.number().int()
}) satisfies z.ZodType<LocationItem>;

/** Message of the day (legacy `mensajes.txt`). */
export interface DailyMessage {
  id: string;
  date: string;
  message: string;
}

export const DAILY_MESSAGE_MAX_LENGTH = 1000;

export const dailyMessageSchema = z.object({
  id: idSchema,
  date: dateSchema,
  message: z.string().max(DAILY_MESSAGE_MAX_LENGTH)
}) satisfies z.ZodType<DailyMessage>;

/** Announcement. `cuencadaId === null` means a portal-wide announcement. */
export interface Announcement {
  id: string;
  cuencadaId: string | null;
  title: string;
  body: string;
  visibility: Visibility;
  pinned: boolean;
  authorName: string | null;
  publishedAt: string;
  /**
   * When it stops being shown, or `null` for never. Contract amendment (T2-BE):
   * public/member reads only ever return unexpired items, admins see every row.
   */
  expiresAt: string | null;
  updatedAt: string;
}

export const announcementSchema = z.object({
  id: idSchema,
  cuencadaId: idSchema.nullable(),
  title: z.string().max(200),
  body: z.string().max(5000),
  visibility: visibilitySchema,
  pinned: z.boolean(),
  authorName: z.string().max(80).nullable(),
  publishedAt: dateTimeSchema,
  expiresAt: dateTimeSchema.nullable(),
  updatedAt: dateTimeSchema
}) satisfies z.ZodType<Announcement>;

/* -------------------------------------------------------------------------- */
/* Cuencada read models                                                        */
/* -------------------------------------------------------------------------- */

/** Card in lists (`GET /api/cuencadas`). Only published editions. */
export interface CuencadaSummary {
  id: string;
  year: number;
  slug: string;
  title: string;
  status: CuencadaStatus;
  startsAt: string;
  endsAt: string;
  /** IANA zone used for status and date display. Contract amendment (T2-BE, for T4-FE). */
  timezone: string;
  city: string;
  state: string;
  heroImageUrl: string | null;
  themeColor: string;
  /**
   * True when the edition has at least one visible gallery item (approved,
   * ready, not deleted). Lets the web hide empty galleries without a member
   * request. Contract amendment (T2-BE, for T4-FE).
   */
  hasMedia: boolean;
}

export const cuencadaSummarySchema = z.object({
  id: idSchema,
  year: z.number().int(),
  slug: z.string().max(32),
  title: z.string().max(200),
  status: cuencadaStatusSchema,
  startsAt: dateTimeSchema,
  endsAt: dateTimeSchema,
  timezone: z.string().max(64),
  city: z.string().max(120),
  state: z.string().max(120),
  heroImageUrl: z.string().max(2048).nullable(),
  themeColor: z.string().max(7),
  hasMedia: z.boolean()
}) satisfies z.ZodType<CuencadaSummary>;

/** Everything an anonymous visitor may see (`GET /api/cuencadas/:year`). */
export interface PublicCuencada {
  id: string;
  year: number;
  slug: string;
  title: string;
  status: CuencadaStatus;
  startsAt: string;
  endsAt: string;
  /** IANA zone used for status, countdown and date display. */
  timezone: string;
  city: string;
  state: string;
  country: string;
  description: string;
  heroImageUrl: string | null;
  themeColor: string;
  songUrl: string | null;
  weatherWidgetUrl: string | null;
  rsvpDeadline: string | null;
  publicItinerary: ItineraryItem[];
  publicLocations: LocationItem[];
  publicAnnouncements: Announcement[];
  /** Today's message (Cuencada timezone), if one exists. */
  todayMessage: DailyMessage | null;
}

export const publicCuencadaSchema = z.object({
  id: idSchema,
  year: z.number().int(),
  slug: z.string().max(32),
  title: z.string().max(200),
  status: cuencadaStatusSchema,
  startsAt: dateTimeSchema,
  endsAt: dateTimeSchema,
  timezone: z.string().max(64),
  city: z.string().max(120),
  state: z.string().max(120),
  country: z.string().max(120),
  description: z.string().max(5000),
  heroImageUrl: z.string().max(2048).nullable(),
  themeColor: z.string().max(7),
  songUrl: z.string().max(2048).nullable(),
  weatherWidgetUrl: z.string().max(2048).nullable(),
  rsvpDeadline: dateTimeSchema.nullable(),
  publicItinerary: z.array(itineraryItemSchema),
  publicLocations: z.array(locationItemSchema),
  publicAnnouncements: z.array(announcementSchema),
  todayMessage: dailyMessageSchema.nullable()
}) satisfies z.ZodType<PublicCuencada>;

/** `GET /api/cuencadas/home`: drives the home page hero vs memories mode. */
export interface CuencadaHome {
  mode: HomeMode;
  /** The upcoming/active edition, or `null` in memories mode. */
  featured: PublicCuencada | null;
  /** Most recent past edition, for memories mode. */
  latestPast: CuencadaSummary | null;
  /**
   * Portal-wide (`cuencadaId: null`) announcements with `visibility: "public"`.
   * This is the only public endpoint that returns them; member-visible
   * portal-wide ones come from `GET /api/announcements`.
   */
  announcements: Announcement[];
}

export const cuencadaHomeSchema = z.object({
  mode: homeModeSchema,
  featured: publicCuencadaSchema.nullable(),
  latestPast: cuencadaSummarySchema.nullable(),
  announcements: z.array(announcementSchema)
}) satisfies z.ZodType<CuencadaHome>;

/**
 * Member-only additions (`GET /api/cuencadas/:year/members`). Merged by the
 * web on top of `PublicCuencada`. Lists contain *all* items (public + members).
 */
export interface MemberCuencadaDetails {
  cuencadaId: string;
  year: number;
  itinerary: ItineraryItem[];
  locations: LocationItem[];
  announcements: Announcement[];
  whatsappUrl: string | null;
  /** Shared external album (legacy OneDrive link). */
  externalAlbumUrl: string | null;
}

export const memberCuencadaDetailsSchema = z.object({
  cuencadaId: idSchema,
  year: z.number().int(),
  itinerary: z.array(itineraryItemSchema),
  locations: z.array(locationItemSchema),
  announcements: z.array(announcementSchema),
  whatsappUrl: z.string().max(2048).nullable(),
  externalAlbumUrl: z.string().max(2048).nullable()
}) satisfies z.ZodType<MemberCuencadaDetails>;

/** Cuencada as seen by admins: every column, including drafts. */
export interface AdminCuencada extends Omit<PublicCuencada, "publicItinerary" | "publicLocations" | "publicAnnouncements" | "todayMessage"> {
  isPublished: boolean;
  whatsappUrl: string | null;
  externalAlbumUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

export const adminCuencadaSchema = publicCuencadaSchema
  .omit({ publicItinerary: true, publicLocations: true, publicAnnouncements: true, todayMessage: true })
  .extend({
    isPublished: z.boolean(),
    whatsappUrl: z.string().max(2048).nullable(),
    externalAlbumUrl: z.string().max(2048).nullable(),
    createdAt: dateTimeSchema,
    updatedAt: dateTimeSchema
  }) satisfies z.ZodType<AdminCuencada>;

/** `GET /api/admin/cuencadas/:id`: the edit screen. */
export interface AdminCuencadaDetail {
  cuencada: AdminCuencada;
  itinerary: ItineraryItem[];
  locations: LocationItem[];
  announcements: Announcement[];
  dailyMessageCount: number;
}

export const adminCuencadaDetailSchema = z.object({
  cuencada: adminCuencadaSchema,
  itinerary: z.array(itineraryItemSchema),
  locations: z.array(locationItemSchema),
  announcements: z.array(announcementSchema),
  dailyMessageCount: z.number().int()
}) satisfies z.ZodType<AdminCuencadaDetail>;

/* -------------------------------------------------------------------------- */
/* Admin inputs                                                                */
/* -------------------------------------------------------------------------- */

const optionalHttpsUrl = httpsUrlSchema.nullable();

/**
 * Fields shared by create and update, without defaults (so PATCH never resets).
 *
 * PATCH refines can only check fields present in the patch. Services MUST
 * re-validate the merged row before writing: `endsAt > startsAt` (cuencada),
 * `endTime > startTime` (itinerary), lat/lng both set or both null (location),
 * `deathYear >= birthYear` (person).
 */
const cuencadaFields = {
  year: yearSchema,
  title: requiredTextSchema(200),
  startsAt: dateTimeSchema,
  endsAt: dateTimeSchema,
  timezone: timezoneSchema,
  city: requiredTextSchema(120),
  state: requiredTextSchema(120),
  country: requiredTextSchema(120),
  description: requiredTextSchema(5000),
  heroImageUrl: assetUrlSchema.nullable(),
  themeColor: hexColorSchema,
  songUrl: assetUrlSchema.nullable(),
  whatsappUrl: optionalHttpsUrl,
  weatherWidgetUrl: optionalHttpsUrl,
  externalAlbumUrl: optionalHttpsUrl,
  rsvpDeadline: dateTimeSchema.nullable(),
  isPublished: z.boolean()
};

function endsAfterStart(value: { startsAt?: string | undefined; endsAt?: string | undefined }): boolean {
  if (value.startsAt === undefined || value.endsAt === undefined) return true;
  return Date.parse(value.endsAt) > Date.parse(value.startsAt);
}

const endsAfterStartIssue = { error: "La fecha de fin debe ser posterior al inicio.", path: ["endsAt"] };

/** `POST /api/admin/cuencadas`. The slug is derived from `year`. */
export const createCuencadaInputSchema = z
  .object({
    ...cuencadaFields,
    timezone: timezoneSchema.default("America/Merida"),
    country: requiredTextSchema(120).default("México"),
    heroImageUrl: assetUrlSchema.nullable().default(null),
    themeColor: hexColorSchema.default("#0b5e55"),
    songUrl: assetUrlSchema.nullable().default(null),
    whatsappUrl: optionalHttpsUrl.default(null),
    weatherWidgetUrl: optionalHttpsUrl.default(null),
    externalAlbumUrl: optionalHttpsUrl.default(null),
    rsvpDeadline: dateTimeSchema.nullable().default(null),
    isPublished: z.boolean().default(false)
  })
  .refine(endsAfterStart, endsAfterStartIssue);
export type CreateCuencadaInput = z.infer<typeof createCuencadaInputSchema>;
export type CreateCuencadaRequest = z.input<typeof createCuencadaInputSchema>;

/** `PATCH /api/admin/cuencadas/:id`. Publishing is `{ isPublished: true }`. */
export const updateCuencadaInputSchema = z
  .object(cuencadaFields)
  .partial()
  .refine(endsAfterStart, endsAfterStartIssue)
  .refine((value) => Object.keys(value).length > 0, { error: "No hay cambios que guardar." });
export type UpdateCuencadaInput = z.infer<typeof updateCuencadaInputSchema>;
export type UpdateCuencadaRequest = z.input<typeof updateCuencadaInputSchema>;

const itineraryFields = {
  date: dateSchema,
  startTime: timeSchema.nullable(),
  endTime: timeSchema.nullable(),
  title: requiredTextSchema(200),
  description: z.string().trim().max(2000),
  locationName: nullableTextSchema(200),
  locationId: idSchema.nullable(),
  priceNote: nullableTextSchema(120),
  tags: itineraryTagsSchema,
  visibility: visibilitySchema
};

function endTimeAfterStart(value: { startTime?: string | null | undefined; endTime?: string | null | undefined }): boolean {
  if (!value.startTime || !value.endTime) return true;
  return value.endTime > value.startTime;
}

const endTimeIssue = { error: "La hora de fin debe ser posterior a la de inicio.", path: ["endTime"] };

/** `POST /api/admin/cuencadas/:id/itinerary`. Appended at the end of its day. */
export const createItineraryItemInputSchema = z
  .object({
    ...itineraryFields,
    startTime: timeSchema.nullable().default(null),
    endTime: timeSchema.nullable().default(null),
    description: z.string().trim().max(2000).default(""),
    locationName: nullableTextSchema(200).default(null),
    locationId: idSchema.nullable().default(null),
    priceNote: nullableTextSchema(120).default(null),
    tags: itineraryTagsSchema.default([]),
    visibility: visibilitySchema.default(Visibility.Public)
  })
  .refine(endTimeAfterStart, endTimeIssue);
export type CreateItineraryItemInput = z.infer<typeof createItineraryItemInputSchema>;
export type CreateItineraryItemRequest = z.input<typeof createItineraryItemInputSchema>;

/** `PATCH /api/admin/itinerary/:id`. */
export const updateItineraryItemInputSchema = z
  .object(itineraryFields)
  .partial()
  .refine(endTimeAfterStart, endTimeIssue)
  .refine((value) => Object.keys(value).length > 0, { error: "No hay cambios que guardar." });
export type UpdateItineraryItemInput = z.infer<typeof updateItineraryItemInputSchema>;
export type UpdateItineraryItemRequest = z.input<typeof updateItineraryItemInputSchema>;

const locationFields = {
  name: requiredTextSchema(200),
  kind: locationKindSchema,
  description: nullableTextSchema(2000),
  address: nullableTextSchema(300),
  url: optionalHttpsUrl,
  mapsUrl: optionalHttpsUrl,
  lat: z.number().min(-90).max(90).nullable(),
  lng: z.number().min(-180).max(180).nullable(),
  visibility: visibilitySchema
};

/**
 * Coordinates are set or cleared together. In a patch, sending only one of
 * `lat`/`lng` is rejected; if both are sent they must both be numbers or both `null`.
 */
function latLngTogether(value: { lat?: number | null | undefined; lng?: number | null | undefined }): boolean {
  const hasLat = value.lat !== undefined;
  const hasLng = value.lng !== undefined;
  if (hasLat !== hasLng) return false;
  if (!hasLat) return true;
  return (value.lat === null) === (value.lng === null);
}

const latLngIssue = { error: "Latitud y longitud van juntas.", path: ["lng"] };

/** `POST /api/admin/cuencadas/:id/locations`. */
export const createLocationInputSchema = z
  .object({
    ...locationFields,
    kind: locationKindSchema.default(LocationKind.Other),
    description: nullableTextSchema(2000).default(null),
    address: nullableTextSchema(300).default(null),
    url: optionalHttpsUrl.default(null),
    mapsUrl: optionalHttpsUrl.default(null),
    lat: z.number().min(-90).max(90).nullable().default(null),
    lng: z.number().min(-180).max(180).nullable().default(null),
    visibility: visibilitySchema.default(Visibility.Public)
  })
  .refine(latLngTogether, latLngIssue);
export type CreateLocationInput = z.infer<typeof createLocationInputSchema>;
export type CreateLocationRequest = z.input<typeof createLocationInputSchema>;

/** `PATCH /api/admin/locations/:id`. */
export const updateLocationInputSchema = z
  .object(locationFields)
  .partial()
  .refine(latLngTogether, latLngIssue)
  .refine((value) => Object.keys(value).length > 0, { error: "No hay cambios que guardar." });
export type UpdateLocationInput = z.infer<typeof updateLocationInputSchema>;
export type UpdateLocationRequest = z.input<typeof updateLocationInputSchema>;

const announcementFields = {
  title: requiredTextSchema(200),
  body: requiredTextSchema(5000),
  visibility: visibilitySchema,
  pinned: z.boolean(),
  /** Schedules the announcement; a future value hides it until then. */
  publishedAt: dateTimeSchema,
  /** Hides it from that moment on; `null` = never expires. */
  expiresAt: dateTimeSchema.nullable()
};

function expiresAfterPublish(value: { publishedAt?: string | undefined; expiresAt?: string | null | undefined }): boolean {
  if (value.publishedAt === undefined || value.expiresAt === undefined || value.expiresAt === null) return true;
  return Date.parse(value.expiresAt) > Date.parse(value.publishedAt);
}

const expiresIssue = { error: "La fecha de vencimiento debe ser posterior a la de publicación.", path: ["expiresAt"] };

/**
 * `POST /api/admin/announcements`. `cuencadaId: null` = portal-wide.
 * `publishedAt` defaults to the server's now (amendment T2-BE: `publishedAt`/`expiresAt`).
 * Kept refinement-free so callers can `.omit()` it (the seed does); the server
 * checks `expiresAt > publishedAt` after applying the default.
 */
export const createAnnouncementInputSchema = z
  .object({
    ...announcementFields,
    cuencadaId: idSchema.nullable(),
    visibility: visibilitySchema.default(Visibility.Members),
    pinned: z.boolean().default(false),
    publishedAt: dateTimeSchema.exactOptional(),
    expiresAt: dateTimeSchema.nullable().default(null)
  });
export type CreateAnnouncementInput = z.infer<typeof createAnnouncementInputSchema>;
export type CreateAnnouncementRequest = z.input<typeof createAnnouncementInputSchema>;

/** `PATCH /api/admin/announcements/:id`. */
export const updateAnnouncementInputSchema = z
  .object(announcementFields)
  .partial()
  .refine(expiresAfterPublish, expiresIssue)
  .refine((value) => Object.keys(value).length > 0, { error: "No hay cambios que guardar." });
export type UpdateAnnouncementInput = z.infer<typeof updateAnnouncementInputSchema>;
export type UpdateAnnouncementRequest = z.input<typeof updateAnnouncementInputSchema>;

/** Which announcements an admin list shows (amendment T2-BE, requested by T2-FE as R7). */
export const AnnouncementScope = {
  /** Portal-wide only (`cuencadaId === null`). */
  Portal: "portal",
  /** Attached to some Cuencada. */
  Cuencada: "cuencada"
} as const;
export type AnnouncementScope = (typeof AnnouncementScope)[keyof typeof AnnouncementScope];
export const announcementScopeSchema = z.enum(AnnouncementScope);

/**
 * `GET /api/admin/announcements` query. `cuencadaId` lists one edition's
 * announcements; `scope` lists portal-wide or edition ones; neither lists all.
 * Sending both is accepted only with `scope: "cuencada"`.
 */
export const adminAnnouncementQuerySchema = z
  .object({
    cuencadaId: idSchema.exactOptional(),
    scope: announcementScopeSchema.exactOptional()
  })
  .refine((value) => value.cuencadaId === undefined || value.scope !== AnnouncementScope.Portal, {
    error: "Un aviso general no pertenece a una Cuencada.",
    path: ["scope"]
  });
export type AdminAnnouncementQuery = z.infer<typeof adminAnnouncementQuerySchema>;
export type AdminAnnouncementQueryRequest = z.input<typeof adminAnnouncementQuerySchema>;

/**
 * Full new order for itinerary items or locations of one Cuencada
 * (`PUT …/itinerary/order`, `PUT …/locations/order`). Must list every id exactly once.
 */
export const reorderInputSchema = z.object({
  ids: z
    .array(idSchema)
    .min(1)
    .max(500)
    .refine((ids) => new Set(ids).size === ids.length, { error: "Hay elementos repetidos." })
});
export type ReorderInput = z.infer<typeof reorderInputSchema>;
export type ReorderRequest = z.input<typeof reorderInputSchema>;

/* -------------------------------------------------------------------------- */
/* Daily messages                                                              */
/* -------------------------------------------------------------------------- */

/** `PUT /api/admin/cuencadas/:id/daily-messages/:date` body (upsert by date). */
export const dailyMessageUpsertInputSchema = z.object({
  message: requiredTextSchema(DAILY_MESSAGE_MAX_LENGTH)
});
export type DailyMessageUpsertInput = z.infer<typeof dailyMessageUpsertInputSchema>;
export type DailyMessageUpsertRequest = z.input<typeof dailyMessageUpsertInputSchema>;

/** `:date` path parameter. */
export const dateParamSchema = z.object({ id: idSchema, date: dateSchema });
export type DateParam = z.infer<typeof dateParamSchema>;

/** A parsed `YYYY-MM-DD|message` line. */
export const dailyMessageEntrySchema = z.object({
  date: dateSchema,
  message: requiredTextSchema(DAILY_MESSAGE_MAX_LENGTH)
});
export type DailyMessageEntry = z.infer<typeof dailyMessageEntrySchema>;

/**
 * Parses one `YYYY-MM-DD|message` line (legacy `mensajes.txt` format).
 * Splits on the *first* `|`, so messages may contain `|`.
 */
export const dailyMessageLineSchema = z
  .string()
  .max(DAILY_MESSAGE_MAX_LENGTH + 20, { error: "La línea es demasiado larga." })
  .transform((line, ctx) => {
    const separator = line.indexOf("|");
    if (separator === -1) {
      ctx.addIssue({ code: "custom", message: "Formato esperado: AAAA-MM-DD|mensaje." });
      return z.NEVER;
    }
    return { date: line.slice(0, separator).trim(), message: line.slice(separator + 1) };
  })
  .pipe(dailyMessageEntrySchema);

export const DAILY_MESSAGES_IMPORT_MAX_CHARS = 200_000;
/** Maximum `entries` in one import (about three years of daily messages). */
export const DAILY_MESSAGES_IMPORT_MAX_ENTRIES = 1000;

export const DailyMessagesImportMode = {
  /** Upsert by date, keep dates not in the file. */
  Merge: "merge",
  /** Delete every message of the Cuencada, then insert the file. */
  Replace: "replace"
} as const;
export type DailyMessagesImportMode = (typeof DailyMessagesImportMode)[keyof typeof DailyMessagesImportMode];
export const dailyMessagesImportModeSchema = z.enum(DailyMessagesImportMode);

/**
 * `POST /api/admin/cuencadas/:id/daily-messages/import` body. The server runs
 * {@link parseDailyMessagesText}; if any line fails, nothing is written and the
 * response is 400 `VALIDATION` with `details` paths like `lines.12`.
 */
export const dailyMessagesImportInputSchema = z
  .object({
    text: z
      .string()
      .min(1, { error: "El archivo está vacío." })
      .max(DAILY_MESSAGES_IMPORT_MAX_CHARS, { error: "El archivo es demasiado grande." })
      .exactOptional(),
    /**
     * Already-parsed entries (amendment T2-BE), e.g. from a form. Combined with
     * `text` when both are sent; a date repeated anywhere is an error.
     */
    entries: z.array(dailyMessageEntrySchema).min(1).max(DAILY_MESSAGES_IMPORT_MAX_ENTRIES).exactOptional(),
    mode: dailyMessagesImportModeSchema.default(DailyMessagesImportMode.Merge)
  })
  .refine((value) => value.text !== undefined || value.entries !== undefined, {
    error: "Envía el texto del archivo o la lista de mensajes.",
    path: ["text"]
  });
export type DailyMessagesImportInput = z.infer<typeof dailyMessagesImportInputSchema>;
export type DailyMessagesImportRequest = z.input<typeof dailyMessagesImportInputSchema>;

/** Successful import summary. */
export interface DailyMessagesImportResult {
  created: number;
  updated: number;
  deleted: number;
}

export const dailyMessagesImportResultSchema = z.object({
  created: z.number().int(),
  updated: z.number().int(),
  deleted: z.number().int()
}) satisfies z.ZodType<DailyMessagesImportResult>;

/** Result of {@link parseDailyMessagesText}. */
export interface ParsedDailyMessages {
  entries: DailyMessageEntry[];
  /**
   * `path` is `lines.<1-based line number>`. Never longer than
   * `API_ERROR_DETAILS_MAX`: past the cap, the last entry is a summary with
   * `path: "lines"`, so it can be returned as `ApiError.details` as-is.
   */
  errors: ApiErrorDetail[];
  /** Total number of invalid lines (may exceed `errors.length`). */
  errorCount: number;
}

/**
 * Parses a whole `mensajes.txt`-style file. Blank lines and lines starting
 * with `#` are skipped; CRLF and a leading BOM are tolerated. A date that
 * appears twice is an error (the file is ambiguous).
 */
export function parseDailyMessagesText(text: string): ParsedDailyMessages {
  const entries: DailyMessageEntry[] = [];
  const errors: ApiErrorDetail[] = [];
  let errorCount = 0;
  const pushError = (detail: ApiErrorDetail): void => {
    errorCount += 1;
    if (errors.length < API_ERROR_DETAILS_MAX) errors.push(detail);
  };
  const seen = new Map<string, number>();
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);

  lines.forEach((rawLine, index) => {
    const lineNumber = index + 1;
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) return;

    const parsed = dailyMessageLineSchema.safeParse(line);
    if (!parsed.success) {
      const message = parsed.error.issues[0]?.message ?? "Línea inválida.";
      pushError({ path: `lines.${lineNumber}`, message });
      return;
    }

    const firstLine = seen.get(parsed.data.date);
    if (firstLine !== undefined) {
      pushError({ path: `lines.${lineNumber}`, message: `Fecha repetida (ya aparece en la línea ${firstLine}).` });
      return;
    }
    seen.set(parsed.data.date, lineNumber);
    entries.push(parsed.data);
  });

  if (errorCount > API_ERROR_DETAILS_MAX) {
    const shown = API_ERROR_DETAILS_MAX - 1;
    errors.length = shown;
    errors.push({ path: "lines", message: `Demasiados errores: se muestran ${shown} y hay ${errorCount - shown} más.` });
  }

  return { entries, errors, errorCount };
}
