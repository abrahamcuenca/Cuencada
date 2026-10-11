/**
 * Eventos (WP-5.2): smaller family events with participants, a participant
 * chat room, photo albums and a 16:9 cover. Contracts only; the routes are
 * WP-5.3 and the pages WP-5.4. Authorization is ADR 0001 §7 and the route
 * list is `docs/coordination/WP-5.2.md`.
 *
 * URLs: `/eventos` (list) and `/eventos/{year}/{slug}` (detail). `(year, slug)`
 * is unique; `year` follows `startsAt` (in the event's timezone) when the
 * event is dated and is chosen explicitly otherwise.
 */
import { z } from "zod";
import {
  type ApiErrorDetail,
  cursorQuerySchema,
  dateTimeSchema,
  hasVisibleChars,
  idSchema,
  pageSchema,
  queryBooleanSchema,
  stripUnsafeChars,
  timezoneSchema,
  yearSchema
} from "./common.js";
import {
  type AvatarUploadResponse,
  type ClampedCrop,
  type ImageCropRect,
  avatarUploadInputSchema,
  avatarUploadResponseSchema,
  imageCropRectSchema
} from "./profile.js";
import {
  EVENT_ALBUM_TITLE_MAX_LENGTH,
  EVENT_SLUG_MAX_LENGTH,
  EVENT_SLUG_MIN_LENGTH,
  EVENT_TITLE_MAX_LENGTH
} from "./eventRefs.js";

// The refs live in a leaf module (no cycle through profile → media); one import path for consumers.
export * from "./eventRefs.js";

/* -------------------------------------------------------------------------- */
/* Enums and limits                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Who may see a (published) event: every verified member, or only its
 * participants (plus admins, audited). See ADR 0001 §7.
 */
export const EventVisibility = {
  Members: "members",
  Participants: "participants"
} as const;
export type EventVisibility = (typeof EventVisibility)[keyof typeof EventVisibility];
export const eventVisibilitySchema = z.enum(EventVisibility);

/**
 * Stored lifecycle. `draft`: organizers and admins only. `published`: per
 * {@link EventVisibility}. `hidden`: admins only (moderation; only an admin
 * sets or clears it).
 */
export const EventStatus = {
  Draft: "draft",
  Published: "published",
  Hidden: "hidden"
} as const;
export type EventStatus = (typeof EventStatus)[keyof typeof EventStatus];
export const eventStatusSchema = z.enum(EventStatus);

/** A participant's role. Organizers manage the event; the creator starts as one. */
export const EventRole = {
  Organizer: "organizer",
  Participant: "participant"
} as const;
export type EventRole = (typeof EventRole)[keyof typeof EventRole];
export const eventRoleSchema = z.enum(EventRole);

/** `GET /api/events?when=`: events still to come (or under way) vs. over. See {@link isPastEvent}. */
export const EventListWhen = {
  Upcoming: "upcoming",
  Past: "past"
} as const;
export type EventListWhen = (typeof EventListWhen)[keyof typeof EventListWhen];
export const eventListWhenSchema = z.enum(EventListWhen);

/** Longest summary (list card). DB CHECK `events_summary_length_check`. */
export const EVENT_SUMMARY_MAX_LENGTH = 280;
/** Longest details text. DB CHECK `events_details_length_check`. */
export const EVENT_DETAILS_MAX_LENGTH = 4000;
/** Longest free-text place. DB CHECK `events_location_text_length_check`. */
export const EVENT_LOCATION_MAX_LENGTH = 160;
/** Slug shape, shared with the DB CHECK `events_slug_check` (lowercase words joined by single dashes). */
export const EVENT_SLUG_PATTERN = "^[a-z0-9]+(?:-[a-z0-9]+)*$";
const eventSlugRegex = new RegExp(EVENT_SLUG_PATTERN);
/** Most users in one "add participants" request. */
export const EVENT_PARTICIPANTS_ADD_MAX = 50;
/** Most participants per event (service cap; `EventDetail.participants` is never longer). */
export const EVENT_PARTICIPANTS_MAX = 500;
/** Most albums per event (service cap). */
export const EVENT_ALBUMS_MAX = 20;
/** Highest album `sortOrder`. DB CHECK `event_albums_sort_order_check`. */
export const EVENT_ALBUM_SORT_ORDER_MAX = 1000;
/** Title of the album created with every event. */
export const DEFAULT_EVENT_ALBUM_TITLE = "Fotos";
/** Default timezone of a new event (same as Cuencadas). */
export const EVENT_DEFAULT_TIMEZONE = "America/Merida";

/** Cover aspect ratio (width / height). */
export const EVENT_COVER_ASPECT = 16 / 9;
/**
 * Cover derivative widths (WebP). Keys: `events/{eventId}/cover/{uploadId}-{width}.webp`.
 * `EventDetail.coverUrl` is the 1280 one, `EventSummary.coverUrl` in lists the 640 one.
 */
export const EVENT_COVER_WIDTHS = [1280, 640] as const;
export type EventCoverWidth = (typeof EVENT_COVER_WIDTHS)[number];

/* -------------------------------------------------------------------------- */
/* Error detail codes                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Stable reasons in the open detail-code channel (ADR 0001 §4), sent as
 * `details: [{ path: "event", message, code }]`. `ErrorCode` stays closed;
 * the top-level code and status for each:
 *
 * | code | top-level | status |
 * | --- | --- | --- |
 * | `EVENT_NOT_FOUND` | `NOT_FOUND` | 404: missing **or not visible** (never 403, no existence leak) |
 * | `EVENT_NOT_PARTICIPANT` | `FORBIDDEN` | 403: visible event, but chat/albums/uploads need a participant |
 * | `EVENT_JOIN_NOT_ALLOWED` | `FORBIDDEN` | 403: self-join only for published `members` events |
 * | `EVENT_SLUG_TAKEN` | `CONFLICT` | 409: `(year, slug)` already used (`path: "slug"`) |
 * | `EVENT_ALBUM_NOT_EMPTY` | `CONFLICT` | 409: delete the album's media first |
 * | `EVENT_DELETE_NOT_ALLOWED` | `FORBIDDEN` | 403: organizers delete only drafts without media |
 * | `EVENT_LAST_ORGANIZER` | `CONFLICT` | 409: the last organizer cannot leave or be demoted/removed |
 * | `EVENT_MANAGE_NOT_ALLOWED` | `FORBIDDEN` | 403: visible event, caller is not an organizer or admin |
 */
export const EventIssueCode = {
  NotFound: "EVENT_NOT_FOUND",
  NotParticipant: "EVENT_NOT_PARTICIPANT",
  JoinNotAllowed: "EVENT_JOIN_NOT_ALLOWED",
  SlugTaken: "EVENT_SLUG_TAKEN",
  AlbumNotEmpty: "EVENT_ALBUM_NOT_EMPTY",
  DeleteNotAllowed: "EVENT_DELETE_NOT_ALLOWED",
  LastOrganizer: "EVENT_LAST_ORGANIZER",
  ManageNotAllowed: "EVENT_MANAGE_NOT_ALLOWED"
} as const;
export type EventIssueCode = (typeof EventIssueCode)[keyof typeof EventIssueCode];

/* -------------------------------------------------------------------------- */
/* Slugs (shared by the web form preview and the server)                       */
/* -------------------------------------------------------------------------- */

/** Letters that NFD does not decompose into a base letter plus marks. */
const LETTER_FOLDS: Readonly<Record<string, string>> = {
  ß: "ss",
  æ: "ae",
  Æ: "AE",
  œ: "oe",
  Œ: "OE",
  ø: "o",
  Ø: "O",
  ł: "l",
  Ł: "L",
  đ: "d",
  Đ: "D"
};

/**
 * Removes accents and diacritics: `"Mérida, Año Nuevo"` → `"Merida, Ano Nuevo"`.
 * NFD then drops combining marks (so `ñ` → `n`, `ü` → `u`), plus a few
 * letters NFD keeps whole (`ß` → `ss`, `ø` → `o`, …). Case is preserved.
 *
 * @param value - Any text.
 * @returns The folded text.
 */
export function foldAccents(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .replace(/[ßæÆœŒøØłŁđĐ]/g, (letter) => LETTER_FOLDS[letter] ?? letter);
}

/** Slug used when a title has fewer than {@link EVENT_SLUG_MIN_LENGTH} usable characters (emoji only, "Yo"). */
export const EVENT_SLUG_FALLBACK = "evento";

/**
 * The URL slug for a title: accents folded, lowercase, every run of other
 * characters → one `-`, no leading/trailing `-`, at most
 * {@link EVENT_SLUG_MAX_LENGTH} characters (cut at a word boundary when
 * possible). Falls back to {@link EVENT_SLUG_FALLBACK} when shorter than 3.
 * The server adds a suffix on collision with {@link eventSlugWithSuffix}.
 *
 * @param title - The event title.
 * @returns A slug matching {@link EVENT_SLUG_PATTERN}.
 */
export function slugifyEventTitle(title: string): string {
  const base = foldAccents(title)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return fitSlug(base, EVENT_SLUG_MAX_LENGTH);
}

function fitSlug(slug: string, max: number): string {
  let out = slug;
  if (out.length > max) {
    const cut = out.slice(0, max);
    // Cut mid-word: drop the partial word if a whole one remains.
    const atBoundary = out[max] === "-" ? cut : cut.replace(/-[^-]*$/, "");
    out = (atBoundary.length >= EVENT_SLUG_MIN_LENGTH ? atBoundary : cut).replace(/-+$/, "");
  }
  return out.length >= EVENT_SLUG_MIN_LENGTH ? out : EVENT_SLUG_FALLBACK;
}

/**
 * `base` with a numeric suffix for the `n`-th collision (`n` ≥ 2):
 * `"carne-asada"`, 2 → `"carne-asada-2"`, still at most 60 characters.
 *
 * @param base - A valid slug.
 * @param n - Attempt number; values below 2 return `base` unchanged.
 * @returns A slug matching {@link EVENT_SLUG_PATTERN}.
 */
export function eventSlugWithSuffix(base: string, n: number): string {
  if (!Number.isInteger(n) || n < 2) return base;
  const suffix = `-${n}`;
  const head = fitSlug(base, EVENT_SLUG_MAX_LENGTH - suffix.length);
  return `${head}${suffix}`;
}

/** True when `value` is a valid event slug (3–60 chars, {@link EVENT_SLUG_PATTERN}). */
export function isEventSlug(value: string): boolean {
  return value.length >= EVENT_SLUG_MIN_LENGTH && value.length <= EVENT_SLUG_MAX_LENGTH && eventSlugRegex.test(value);
}

/** A slug typed by an organizer: trimmed, lowercased, then checked. */
export const eventSlugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(EVENT_SLUG_MAX_LENGTH, { error: `Máximo ${EVENT_SLUG_MAX_LENGTH} caracteres.` })
  .refine(isEventSlug, { error: "Usa de 3 a 60 letras minúsculas, números y guiones (sin acentos ni espacios)." });

/* -------------------------------------------------------------------------- */
/* Dates and year                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Calendar year of an instant in a timezone, or `null` when either is
 * invalid. The DB CHECK `events_year_check` computes the same value with
 * `extract(year from starts_at at time zone timezone)`.
 *
 * @param startsAt - ISO instant.
 * @param timeZone - IANA zone.
 */
export function eventYearOf(startsAt: string, timeZone: string): number | null {
  const instant = Date.parse(startsAt);
  if (Number.isNaN(instant)) return null;
  try {
    const year = Number(new Intl.DateTimeFormat("en", { timeZone, year: "numeric" }).format(instant));
    return Number.isInteger(year) ? year : null;
  } catch {
    return null;
  }
}

/** Spanish messages shared by the contract refines and the server's merged-row check. */
export const EVENT_DATES_TOGETHER_MESSAGE = "Escribe las dos fechas (inicio y fin) o deja ambas vacías.";
export const EVENT_ENDS_AFTER_START_MESSAGE = "La fecha de fin debe ser posterior al inicio.";
export const EVENT_YEAR_REQUIRED_MESSAGE = "Elige el año del evento.";
export const EVENT_YEAR_MISMATCH_MESSAGE = "El año debe coincidir con la fecha de inicio.";

/** The stored fields that the date/year rules read. */
export interface EventDateFields {
  year: number | null;
  startsAt: string | null;
  endsAt: string | null;
  timezone: string;
}

/**
 * The merged-row check every event write must run on the server (PATCH
 * refines only see the fields in the patch): both dates or neither,
 * `endsAt > startsAt`, a `year` when undated, and `year` = the year of
 * `startsAt` in `timezone` when dated. Mirrors the DB CHECKs, so a write that
 * passes never surfaces as a 23514.
 *
 * @param row - The row as it would be written (`year: null` = not chosen).
 * @returns The first problem as a validation detail, or `null`.
 */
export function eventDatesIssue(row: EventDateFields): ApiErrorDetail | null {
  if ((row.startsAt === null) !== (row.endsAt === null)) return { path: "endsAt", message: EVENT_DATES_TOGETHER_MESSAGE };
  if (row.startsAt !== null && row.endsAt !== null) {
    if (!(Date.parse(row.endsAt) > Date.parse(row.startsAt))) return { path: "endsAt", message: EVENT_ENDS_AFTER_START_MESSAGE };
    const derived = eventYearOf(row.startsAt, row.timezone);
    if (derived === null) return { path: "startsAt", message: "Fecha y hora inválidas." };
    if (row.year !== null && row.year !== derived) return { path: "year", message: EVENT_YEAR_MISMATCH_MESSAGE };
    return null;
  }
  if (row.year === null) return { path: "year", message: EVENT_YEAR_REQUIRED_MESSAGE };
  return null;
}

/**
 * Whether an event is over (`?when=past`), the same rule as Cuencadas (WP-5.1):
 * dated → `endsAt` is before `now`; undated → its `year` is before the
 * current year in the event's timezone. Everything else is `upcoming`.
 *
 * @param event - Year, end and timezone.
 * @param now - The reference instant.
 */
export function isPastEvent(event: { year: number; endsAt: string | null; timezone: string }, now: Date): boolean {
  if (event.endsAt !== null) return Date.parse(event.endsAt) < now.getTime();
  const currentYear = eventYearOf(now.toISOString(), event.timezone) ?? now.getUTCFullYear();
  return event.year < currentYear;
}

/* -------------------------------------------------------------------------- */
/* Text fields                                                                 */
/* -------------------------------------------------------------------------- */

const CONTROL_CHARS = /[\u0000-\u0008\u000B-\u001F\u007F]/;
const LINE_BREAKS = /[\r\n\t]/;

/** NFC, bidi/invisible marks stripped (ZWJ kept for emoji), CRLF → LF, trimmed. */
function cleanText(value: string): string {
  return stripUnsafeChars(value.normalize("NFC")).replace(/\r\n?/g, "\n").trim();
}

/** Required one-line text (title): no line breaks or control characters, at least one visible character. */
function eventLineSchema(max: number) {
  return z
    .string()
    .max(max * 2, { error: `Máximo ${max} caracteres.` })
    .transform(cleanText)
    .pipe(
      z
        .string()
        .min(1, { error: "Este campo es obligatorio." })
        .max(max, { error: `Máximo ${max} caracteres.` })
        .refine((value) => !LINE_BREAKS.test(value) && !CONTROL_CHARS.test(value), { error: "Usa una sola línea." })
        .refine(hasVisibleChars, { error: "Este campo es obligatorio." })
    );
}

/** Optional text stored as `null` when blank. `multiline` allows `\n` (details). */
function nullableEventTextSchema(max: number, multiline: boolean) {
  return z
    .string()
    .max(max * 2, { error: `Máximo ${max} caracteres.` })
    .nullable()
    .transform((value) => {
      if (value === null) return null;
      const cleaned = cleanText(value);
      return cleaned === "" || !hasVisibleChars(cleaned) ? null : cleaned;
    })
    .pipe(
      z
        .string()
        .max(max, { error: `Máximo ${max} caracteres.` })
        .refine((value) => !CONTROL_CHARS.test(value) && (multiline || !LINE_BREAKS.test(value)), {
          error: multiline ? "Contiene caracteres no permitidos." : "Usa una sola línea."
        })
        .nullable()
    );
}

/** Event title: one line, 1–120 characters. */
export const eventTitleSchema = eventLineSchema(EVENT_TITLE_MAX_LENGTH);
/** Album title: one line, 1–80 characters. */
export const eventAlbumTitleSchema = eventLineSchema(EVENT_ALBUM_TITLE_MAX_LENGTH);
export const eventSummaryTextSchema = nullableEventTextSchema(EVENT_SUMMARY_MAX_LENGTH, false);
export const eventDetailsSchema = nullableEventTextSchema(EVENT_DETAILS_MAX_LENGTH, true);
export const eventLocationTextSchema = nullableEventTextSchema(EVENT_LOCATION_MAX_LENGTH, false);

/** Distinct user ids, 1..`max`. */
function userIdListSchema(max: number) {
  return z
    .array(idSchema)
    .min(1, { error: "Elige al menos una persona." })
    .max(max, { error: `Máximo ${max} personas a la vez.` })
    .refine((ids) => new Set(ids).size === ids.length, { error: "Hay personas repetidas." });
}

/* -------------------------------------------------------------------------- */
/* Create / update                                                             */
/* -------------------------------------------------------------------------- */

type DatesPatch = { startsAt?: string | null | undefined; endsAt?: string | null | undefined };

/** Both dates or neither; in a PATCH a lone non-null date may move one end (the server checks the merged row). */
function datesTogether(value: DatesPatch): boolean {
  const hasStart = value.startsAt !== undefined;
  const hasEnd = value.endsAt !== undefined;
  if (hasStart && hasEnd) return (value.startsAt === null) === (value.endsAt === null);
  if (hasStart) return value.startsAt !== null;
  if (hasEnd) return value.endsAt !== null;
  return true;
}

function endsAfterStart(value: DatesPatch): boolean {
  if (value.startsAt === undefined || value.startsAt === null || value.endsAt === undefined || value.endsAt === null) return true;
  return Date.parse(value.endsAt) > Date.parse(value.startsAt);
}

/** When `year` and `startsAt` are both sent (and `timezone` is known), they must agree. */
function yearMatchesStart(value: { year?: number | undefined; startsAt?: string | null | undefined; timezone?: string | undefined }): boolean {
  if (value.year === undefined || value.startsAt === undefined || value.startsAt === null || value.timezone === undefined) return true;
  const derived = eventYearOf(value.startsAt, value.timezone);
  return derived === null || derived === value.year;
}

const datesTogetherIssue = { error: EVENT_DATES_TOGETHER_MESSAGE, path: ["endsAt"] };
const endsAfterStartIssue = { error: EVENT_ENDS_AFTER_START_MESSAGE, path: ["endsAt"] };
const yearMismatchIssue = { error: EVENT_YEAR_MISMATCH_MESSAGE, path: ["year"] };

/** Fields shared by create and update, without defaults (a PATCH never resets omitted fields). */
const eventFields = {
  title: eventTitleSchema,
  /** Omit to derive it from the title ({@link slugifyEventTitle}); the server suffixes it on collision. */
  slug: eventSlugSchema,
  /** Required when undated; when dated it may be omitted (derived from `startsAt`) and must match. */
  year: yearSchema,
  summary: eventSummaryTextSchema,
  details: eventDetailsSchema,
  startsAt: dateTimeSchema.nullable(),
  endsAt: dateTimeSchema.nullable(),
  timezone: timezoneSchema,
  locationText: eventLocationTextSchema,
  visibility: eventVisibilitySchema
};

/**
 * `POST /api/events` (any verified member; the caller becomes its organizer).
 * Creates the event, its default "Fotos" album and, when published, its chat
 * room. `publish: true` publishes right away (else `draft`).
 * `participantUserIds` adds verified, active members as participants (the
 * caller is added as organizer regardless and may be listed or not).
 * Responds 201 with {@link EventDetail}.
 */
export const createEventInputSchema = z
  .strictObject({
    ...eventFields,
    slug: eventSlugSchema.exactOptional(),
    year: yearSchema.exactOptional(),
    summary: eventSummaryTextSchema.default(null),
    details: eventDetailsSchema.default(null),
    startsAt: dateTimeSchema.nullable().default(null),
    endsAt: dateTimeSchema.nullable().default(null),
    timezone: timezoneSchema.default(EVENT_DEFAULT_TIMEZONE),
    locationText: eventLocationTextSchema.default(null),
    visibility: eventVisibilitySchema.default(EventVisibility.Members),
    publish: z.boolean().default(false),
    participantUserIds: z
      .array(idSchema)
      .max(EVENT_PARTICIPANTS_ADD_MAX, { error: `Máximo ${EVENT_PARTICIPANTS_ADD_MAX} personas a la vez.` })
      .refine((ids) => new Set(ids).size === ids.length, { error: "Hay personas repetidas." })
      .default([])
  })
  .refine(datesTogether, datesTogetherIssue)
  .refine(endsAfterStart, endsAfterStartIssue)
  .refine((value) => value.startsAt !== null || value.year !== undefined, { error: EVENT_YEAR_REQUIRED_MESSAGE, path: ["year"] })
  .refine(yearMatchesStart, yearMismatchIssue);
export type CreateEventInput = z.infer<typeof createEventInputSchema>;
export type CreateEventRequest = z.input<typeof createEventInputSchema>;

/**
 * `PATCH /api/events/:id` (organizers and admins). `status`: organizers may
 * move `draft` ↔ `published`; `hidden` (to or from) is admin-only (403
 * `FORBIDDEN`). Changing `startsAt` re-derives `year` (the URL may change);
 * the server runs {@link eventDatesIssue} on the merged row. Tightening
 * `visibility` to `participants` revokes non-participants' access live.
 */
export const updateEventInputSchema = z
  .strictObject({ ...eventFields, status: eventStatusSchema })
  .partial()
  .refine(datesTogether, datesTogetherIssue)
  .refine(endsAfterStart, endsAfterStartIssue)
  .refine(yearMatchesStart, yearMismatchIssue)
  .refine((value) => Object.keys(value).length > 0, { error: "No hay cambios que guardar." });
export type UpdateEventInput = z.infer<typeof updateEventInputSchema>;
export type UpdateEventRequest = z.input<typeof updateEventInputSchema>;

/* -------------------------------------------------------------------------- */
/* Participants                                                                */
/* -------------------------------------------------------------------------- */

/**
 * `POST /api/events/:id/participants` (organizers and admins): adds verified,
 * active members. Existing participants are left as they are (idempotent).
 * Responds with {@link EventDetail}.
 */
export const addEventParticipantsInputSchema = z.strictObject({
  userIds: userIdListSchema(EVENT_PARTICIPANTS_ADD_MAX),
  role: eventRoleSchema.default(EventRole.Participant)
});
export type AddEventParticipantsInput = z.infer<typeof addEventParticipantsInputSchema>;
export type AddEventParticipantsRequest = z.input<typeof addEventParticipantsInputSchema>;

/** `PATCH /api/events/:id/participants/:userId` (organizers and admins): promote or demote. */
export const updateEventParticipantInputSchema = z.strictObject({ role: eventRoleSchema });
export type UpdateEventParticipantInput = z.infer<typeof updateEventParticipantInputSchema>;
export type UpdateEventParticipantRequest = z.input<typeof updateEventParticipantInputSchema>;

/**
 * Body of `POST /api/events/:id/join` and other body-less writes: none, `{}`
 * or `null` (Fastify validates a missing body as `null`).
 */
export const emptyEventBodySchema = z.strictObject({}).nullish();
export type EmptyEventBody = z.infer<typeof emptyEventBodySchema>;

/* -------------------------------------------------------------------------- */
/* Albums                                                                      */
/* -------------------------------------------------------------------------- */

/** `POST /api/events/:id/albums` (organizers and admins). Responds 201 with {@link EventAlbum}. */
export const createEventAlbumInputSchema = z.strictObject({ title: eventAlbumTitleSchema });
export type CreateEventAlbumInput = z.infer<typeof createEventAlbumInputSchema>;
export type CreateEventAlbumRequest = z.input<typeof createEventAlbumInputSchema>;

/** `PATCH /api/events/:id/albums/:albumId` (organizers and admins). Responds with {@link EventAlbum}. */
export const updateEventAlbumInputSchema = z
  .strictObject({
    title: eventAlbumTitleSchema,
    sortOrder: z.number().int().min(0).max(EVENT_ALBUM_SORT_ORDER_MAX)
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, { error: "No hay cambios que guardar." });
export type UpdateEventAlbumInput = z.infer<typeof updateEventAlbumInputSchema>;
export type UpdateEventAlbumRequest = z.input<typeof updateEventAlbumInputSchema>;

/* -------------------------------------------------------------------------- */
/* Cover (16:9)                                                                */
/* -------------------------------------------------------------------------- */

/**
 * `POST /api/events/:id/cover/uploads` (organizers and admins): the avatar
 * upload intent (JPEG/PNG/WebP, ≤ 10 MB). Responds with
 * {@link EventCoverUploadResponse}.
 */
export const eventCoverUploadInputSchema = avatarUploadInputSchema;
export type EventCoverUploadInput = z.infer<typeof eventCoverUploadInputSchema>;
export type EventCoverUploadRequest = z.input<typeof eventCoverUploadInputSchema>;

export type EventCoverUploadResponse = AvatarUploadResponse;
export const eventCoverUploadResponseSchema = avatarUploadResponseSchema;

/**
 * Body of `POST /api/events/:id/cover/uploads/:uploadId/confirm`. Responds with
 * {@link EventDetail}. `crop` reuses the WP-4.0 {@link ImageCropRect}: for a
 * cover, `size` is the crop **width** and the height is
 * `round(size / EVENT_COVER_ASPECT)`; the server clamps it with
 * {@link clampAspectCropRect}. The web crops 16:9 client-side and omits it.
 */
export const eventCoverConfirmBodySchema = z.strictObject({ crop: imageCropRectSchema.exactOptional() });
export type EventCoverConfirmBody = z.infer<typeof eventCoverConfirmBodySchema>;
export type EventCoverConfirmBodyRequest = z.input<typeof eventCoverConfirmBodySchema>;

/**
 * Clamps a crop to a `width × height` image at a fixed aspect ratio, keeping
 * the user's framing as far as possible (the {@link clampCropRect} rules for
 * a non-square box): the crop width is `rect.size`, capped so the box fits
 * (`≤ width`, `≤ height × aspect`); the height follows the aspect; then the
 * origin is shifted back inside.
 *
 * @param rect - Crop parsed by `imageCropRectSchema` (`size` = width).
 * @param width - Image width after EXIF rotation (integer ≥ 1).
 * @param height - Image height after EXIF rotation (integer ≥ 1).
 * @param aspect - Width / height, finite and > 0 (e.g. {@link EVENT_COVER_ASPECT}).
 * @returns The region to `extract()`.
 * @throws RangeError on invalid dimensions, aspect or a non-finite rect.
 */
export function clampAspectCropRect(rect: ImageCropRect, width: number, height: number, aspect: number): ClampedCrop {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new RangeError("clampAspectCropRect: invalid image dimensions");
  }
  if (!Number.isFinite(aspect) || aspect <= 0) throw new RangeError("clampAspectCropRect: invalid aspect");
  if (!Number.isFinite(rect.x) || !Number.isFinite(rect.y) || !Number.isFinite(rect.size)) {
    throw new RangeError("clampAspectCropRect: invalid crop rect");
  }
  const maxWidth = Math.max(1, Math.min(width, Math.floor(height * aspect)));
  const cropWidth = Math.max(1, Math.min(Math.trunc(rect.size), maxWidth));
  const cropHeight = Math.max(1, Math.min(height, Math.round(cropWidth / aspect)));
  const left = Math.min(Math.max(0, Math.trunc(rect.x)), width - cropWidth);
  const top = Math.min(Math.max(0, Math.trunc(rect.y)), height - cropHeight);
  return { left, top, width: cropWidth, height: cropHeight };
}

/* -------------------------------------------------------------------------- */
/* Params and queries                                                          */
/* -------------------------------------------------------------------------- */

/** `:year/:slug` of `GET /api/events/:year/:slug`. A malformed slug is a 400. */
export const eventPathParamsSchema = z.object({
  year: z.coerce.number<number | string>().pipe(yearSchema),
  slug: eventSlugSchema
});
export type EventPathParams = z.infer<typeof eventPathParamsSchema>;

/** `:id` of `/api/events/:id/…`. */
export const eventIdParamsSchema = z.object({ id: idSchema });
export type EventIdParams = z.infer<typeof eventIdParamsSchema>;

/** `:id/participants/:userId` (the literal `me` route is separate: `DELETE …/participants/me`). */
export const eventParticipantParamsSchema = z.object({ id: idSchema, userId: idSchema });
export type EventParticipantParams = z.infer<typeof eventParticipantParamsSchema>;

/** `:id/albums/:albumId`. */
export const eventAlbumParamsSchema = z.object({ id: idSchema, albumId: idSchema });
export type EventAlbumParams = z.infer<typeof eventAlbumParamsSchema>;

/** `:id/cover/uploads/:uploadId`. */
export const eventCoverUploadParamsSchema = z.object({ id: idSchema, uploadId: idSchema });
export type EventCoverUploadParams = z.infer<typeof eventCoverUploadParamsSchema>;

const queryYearSchema = z.coerce.number<number | string>().pipe(yearSchema);

/**
 * `GET /api/events`: the events the caller may see (ADR 0001 §7), keyset
 * paged. `upcoming` orders by `year`, `startsAt` (nulls last), `id`
 * ascending; `past` by `year`, `startsAt` (nulls last), `id` descending.
 * `mine: true` keeps only events the caller participates in. Hidden events
 * never appear here (admins use `GET /api/admin/events`).
 */
export const eventListQuerySchema = cursorQuerySchema.extend({
  when: eventListWhenSchema.default(EventListWhen.Upcoming),
  year: queryYearSchema.exactOptional(),
  mine: queryBooleanSchema.exactOptional()
});
export type EventListQuery = z.infer<typeof eventListQuerySchema>;
export type EventListQueryRequest = z.input<typeof eventListQuerySchema>;

/** `GET /api/admin/events`: every event, hidden and drafts included, newest `created_at` first. */
export const adminEventListQuerySchema = cursorQuerySchema.extend({
  status: eventStatusSchema.exactOptional(),
  visibility: eventVisibilitySchema.exactOptional(),
  year: queryYearSchema.exactOptional()
});
export type AdminEventListQuery = z.infer<typeof adminEventListQuerySchema>;
export type AdminEventListQueryRequest = z.input<typeof adminEventListQuerySchema>;

/* -------------------------------------------------------------------------- */
/* Read models                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * A list card. Every flag is server-computed for the caller.
 */
export interface EventSummary {
  id: string;
  year: number;
  slug: string;
  title: string;
  summary: string | null;
  startsAt: string | null;
  endsAt: string | null;
  timezone: string;
  locationText: string | null;
  /** Presigned cover (640 px in lists, 1280 px in {@link EventDetail}), `null` without a cover. */
  coverUrl: string | null;
  visibility: EventVisibility;
  status: EventStatus;
  participantCount: number;
  /** The caller's role, `null` when not a participant (admins included). */
  viewerRole: EventRole | null;
  /** Organizer or admin: edit, visibility, participants, albums, cover, publish. */
  canManage: boolean;
  /** "Me apunto": published, `members` visibility, caller not yet a participant. */
  canJoin: boolean;
  /** The caller may open the event chat (participant, or admin; admins on `participants` events are audited). */
  hasChat: boolean;
}

export const eventSummarySchema = z.object({
  id: idSchema,
  year: yearSchema,
  slug: z.string().max(EVENT_SLUG_MAX_LENGTH),
  title: z.string().max(EVENT_TITLE_MAX_LENGTH),
  summary: z.string().max(EVENT_SUMMARY_MAX_LENGTH).nullable(),
  startsAt: dateTimeSchema.nullable(),
  endsAt: dateTimeSchema.nullable(),
  timezone: z.string().max(64),
  locationText: z.string().max(EVENT_LOCATION_MAX_LENGTH).nullable(),
  coverUrl: z.string().max(4096).nullable(),
  visibility: eventVisibilitySchema,
  status: eventStatusSchema,
  participantCount: z.number().int().min(0),
  viewerRole: eventRoleSchema.nullable(),
  canManage: z.boolean(),
  canJoin: z.boolean(),
  hasChat: z.boolean()
}) satisfies z.ZodType<EventSummary>;

/** `GET /api/events` response. */
export const eventPageSchema = pageSchema(eventSummarySchema);

/**
 * A participant as shown on the event page.
 *
 * [SEC] `userId` is present only when the caller is that participant, can
 * manage the event (needed to remove or promote), or the participant is
 * listed in the directory and active; otherwise it is **absent** (not
 * `null`), like `DirectoryEntry` contacts. Never an email or contact.
 */
export interface EventParticipant {
  userId?: string;
  displayName: string;
  /** The account avatar (unlisted/disabled rules as in chat). */
  avatarUrl: string | null;
  role: EventRole;
  joinedAt: string;
  /** True for the caller's own row. */
  isSelf: boolean;
}

export const eventParticipantSchema = z.object({
  userId: idSchema.exactOptional(),
  displayName: z.string().max(80),
  avatarUrl: z.string().max(4096).nullable(),
  role: eventRoleSchema,
  joinedAt: dateTimeSchema,
  isSelf: z.boolean()
}) satisfies z.ZodType<EventParticipant>;

/** An album; `mediaCount` and the cover thumbnail count only items the caller can see. */
export interface EventAlbum {
  id: string;
  eventId: string;
  title: string;
  sortOrder: number;
  mediaCount: number;
  /** Presigned 400px thumb of the newest visible image, or `null`. */
  coverThumbUrl: string | null;
  createdAt: string;
}

export const eventAlbumSchema = z.object({
  id: idSchema,
  eventId: idSchema,
  title: z.string().max(EVENT_ALBUM_TITLE_MAX_LENGTH),
  sortOrder: z.number().int().min(0).max(EVENT_ALBUM_SORT_ORDER_MAX),
  mediaCount: z.number().int().min(0),
  coverThumbUrl: z.string().max(4096).nullable(),
  createdAt: dateTimeSchema
}) satisfies z.ZodType<EventAlbum>;

/**
 * `GET /api/events/:year/:slug` and every event write. `albums` is empty and
 * `chatRoomId` `null` unless `hasChat` (participants and admins).
 */
export interface EventDetail extends EventSummary {
  details: string | null;
  firstPublishedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** Ordered organizers first, then by `joinedAt`. At most {@link EVENT_PARTICIPANTS_MAX}. */
  participants: EventParticipant[];
  albums: EventAlbum[];
  chatRoomId: string | null;
  /** Admin; or an organizer while the event is a draft with no media. */
  canDelete: boolean;
  /** A participant who is not the last organizer. */
  canLeave: boolean;
}

export const eventDetailSchema = eventSummarySchema.extend({
  details: z.string().max(EVENT_DETAILS_MAX_LENGTH).nullable(),
  firstPublishedAt: dateTimeSchema.nullable(),
  createdAt: dateTimeSchema,
  updatedAt: dateTimeSchema,
  participants: z.array(eventParticipantSchema).max(EVENT_PARTICIPANTS_MAX),
  albums: z.array(eventAlbumSchema).max(EVENT_ALBUMS_MAX),
  chatRoomId: idSchema.nullable(),
  canDelete: z.boolean(),
  canLeave: z.boolean()
}) satisfies z.ZodType<EventDetail>;

/** `GET /api/admin/events` item. */
export interface AdminEventSummary extends EventSummary {
  createdByUserId: string | null;
  createdByName: string | null;
  firstPublishedAt: string | null;
  /** All live media in the event's albums (any moderation state). */
  mediaCount: number;
  createdAt: string;
}

export const adminEventSummarySchema = eventSummarySchema.extend({
  createdByUserId: idSchema.nullable(),
  createdByName: z.string().max(80).nullable(),
  firstPublishedAt: dateTimeSchema.nullable(),
  mediaCount: z.number().int().min(0),
  createdAt: dateTimeSchema
}) satisfies z.ZodType<AdminEventSummary>;

export const adminEventPageSchema = pageSchema(adminEventSummarySchema);
