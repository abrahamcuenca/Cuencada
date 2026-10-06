/**
 * Shared primitives for every API contract: error envelope, pagination,
 * and defensive scalar schemas (ids, dates, times, colors, emails, URLs).
 *
 * Every string schema in this package has a maximum length. That limit is a
 * security requirement (it bounds memory, log size and DB writes), not a UX
 * nicety. Do not remove it.
 */
import { z } from "zod";

/* -------------------------------------------------------------------------- */
/* Error envelope                                                              */
/* -------------------------------------------------------------------------- */

/** Machine-readable error codes. The web branches on these, never on `message`. */
export const ErrorCode = {
  /** Request body, query or params failed schema validation (400). */
  VALIDATION: "VALIDATION",
  /** No valid access token, or the session was revoked (401). */
  UNAUTHENTICATED: "UNAUTHENTICATED",
  /** The access token expired; the client should refresh and retry (401). */
  TOKEN_EXPIRED: "TOKEN_EXPIRED",
  /** Wrong email/password. Deliberately generic: no account enumeration (401). */
  INVALID_CREDENTIALS: "INVALID_CREDENTIALS",
  /** Authenticated but not allowed (403). */
  FORBIDDEN: "FORBIDDEN",
  /** The user must change the temporary password before doing anything else (403). */
  PASSWORD_CHANGE_REQUIRED: "PASSWORD_CHANGE_REQUIRED",
  /** Missing/invalid `X-Cuencada-CSRF` header or `Origin` on cookie-authenticated routes (403). */
  CSRF_FAILED: "CSRF_FAILED",
  /** Resource does not exist or is not visible to the caller (404). */
  NOT_FOUND: "NOT_FOUND",
  /** Uniqueness or state conflict, e.g. duplicate year or cycle in the family tree (409). */
  CONFLICT: "CONFLICT",
  /** A concurrent refresh already rotated this token inside the grace window (409). Retry after the other tab finishes. */
  REFRESH_RACE: "REFRESH_RACE",
  /** Invite token is unknown, expired, revoked or used up. Deliberately generic (400). */
  INVITE_INVALID: "INVITE_INVALID",
  /** Magic-link, password-reset or email-verification token is unknown, expired or used (400). */
  TOKEN_INVALID: "TOKEN_INVALID",
  /** Upload rejected: MIME type, size, or magic bytes do not match (400). */
  UPLOAD_INVALID: "UPLOAD_INVALID",
  /** Request body exceeds the route limit (413). */
  PAYLOAD_TOO_LARGE: "PAYLOAD_TOO_LARGE",
  /** Too many requests; see the `Retry-After` header (429). */
  RATE_LIMITED: "RATE_LIMITED",
  /** A dependency (DB, storage, mail) is not configured or not reachable (503). */
  SERVICE_UNAVAILABLE: "SERVICE_UNAVAILABLE",
  /** Unexpected failure. The message never contains internals (500). */
  INTERNAL: "INTERNAL"
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];
export const errorCodeSchema = z.enum(ErrorCode);

/** HTTP status the server must use for each error code. */
export const errorHttpStatus = {
  VALIDATION: 400,
  UNAUTHENTICATED: 401,
  TOKEN_EXPIRED: 401,
  INVALID_CREDENTIALS: 401,
  FORBIDDEN: 403,
  PASSWORD_CHANGE_REQUIRED: 403,
  CSRF_FAILED: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  REFRESH_RACE: 409,
  INVITE_INVALID: 400,
  TOKEN_INVALID: 400,
  UPLOAD_INVALID: 400,
  PAYLOAD_TOO_LARGE: 413,
  RATE_LIMITED: 429,
  SERVICE_UNAVAILABLE: 503,
  INTERNAL: 500
} as const satisfies Record<ErrorCode, number>;

/** One field-level validation problem. `path` is dot-joined, e.g. `itinerary.0.title` or `lines.12`. */
export interface ApiErrorDetail {
  path: string;
  message: string;
}

/**
 * Error envelope returned by every non-2xx response.
 * `message` is Spanish, user-presentable, produced server-side, and never
 * includes stack traces, SQL, token material or other users' data.
 */
export interface ApiError {
  error: {
    code: ErrorCode;
    message: string;
    details?: ApiErrorDetail[];
  };
}

export const apiErrorDetailSchema = z.object({
  path: z.string().max(200),
  message: z.string().max(500)
}) satisfies z.ZodType<ApiErrorDetail>;

export const apiErrorSchema = z.object({
  error: z.object({
    code: errorCodeSchema,
    message: z.string().max(500),
    details: z.array(apiErrorDetailSchema).max(100).exactOptional()
  })
}) satisfies z.ZodType<ApiError>;

/** Body of endpoints that only acknowledge (e.g. generic "if the email exists we sent a link"). */
export interface OkResponse {
  ok: true;
}
export const okResponseSchema = z.object({ ok: z.literal(true) }) satisfies z.ZodType<OkResponse>;

/** `GET /health/ready` response. */
export interface HealthResponse {
  ok: boolean;
  service: string;
  db: boolean;
}
export const healthResponseSchema = z.object({
  ok: z.boolean(),
  service: z.string().max(100),
  db: z.boolean()
}) satisfies z.ZodType<HealthResponse>;

/* -------------------------------------------------------------------------- */
/* Visibility                                                                  */
/* -------------------------------------------------------------------------- */

/** Who can see a piece of Cuencada content. `members` requires login. */
export const Visibility = {
  Public: "public",
  Members: "members"
} as const;
export type Visibility = (typeof Visibility)[keyof typeof Visibility];
export const visibilitySchema = z.enum(Visibility);

/* -------------------------------------------------------------------------- */
/* Scalars                                                                     */
/* -------------------------------------------------------------------------- */

/** Database identifier (Postgres `uuid`, generated server-side). */
export const idSchema = z.uuid({ error: "Identificador inválido." });
/** Alias of {@link idSchema} for readability where the value is not a row id. */
export const uuidSchema = idSchema;

/** Calendar date `YYYY-MM-DD` (no time zone; interpreted in the Cuencada's timezone). */
export const dateSchema = z.iso.date({ error: "Fecha inválida (AAAA-MM-DD)." });

/** Wall-clock time `HH:MM`, 24h. */
export const timeSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, { error: "Hora inválida (HH:MM, 24 horas)." });

/** ISO-8601 instant with offset or `Z`, e.g. `2026-09-13T19:30:00-06:00`. */
export const dateTimeSchema = z.iso.datetime({ offset: true, error: "Fecha y hora inválidas." });

/** `#rrggbb` color. Normalized to lowercase. */
export const hexColorSchema = z
  .string()
  .trim()
  .regex(/^#[0-9a-fA-F]{6}$/, { error: "Color inválido (#rrggbb)." })
  .toLowerCase();

/** IANA time zone name, e.g. `America/Merida`. */
export const timezoneSchema = z
  .string()
  .trim()
  .max(64)
  .regex(/^[A-Za-z]+(?:\/[A-Za-z0-9_+-]+){0,2}$|^UTC$/, { error: "Zona horaria inválida." });

/** Max email length per RFC 5321. */
export const EMAIL_MAX_LENGTH = 254;

/**
 * Email address: trimmed and lowercased *before* validation, so
 * `"  Ana@Example.COM "` becomes `"ana@example.com"`. Use this everywhere an
 * email enters the system so lookups and uniqueness are case-insensitive.
 */
export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(EMAIL_MAX_LENGTH, { error: "El correo es demasiado largo." })
  .pipe(z.email({ error: "Correo electrónico inválido." }));

/**
 * External link entered by an admin (hotel, WhatsApp, OneDrive, Maps, song…).
 * Only `https:` is accepted, which also rules out `javascript:` and `data:` URLs.
 */
export const httpsUrlSchema = z
  .string()
  .trim()
  .max(2048, { error: "El enlace es demasiado largo." })
  .pipe(z.url({ protocol: /^https$/, error: "El enlace debe empezar con https://" }));

/**
 * Site asset reference (hero image, song): an `https:` URL or a site-relative path
 * under `/images/` or `/canciones/` (assets shipped in `apps/web/public`).
 */
export const assetUrlSchema = z.union([
  httpsUrlSchema,
  z
    .string()
    .trim()
    .max(512)
    .regex(/^\/(?:images|canciones)\/[A-Za-z0-9._\-/]+$/, { error: "Ruta de archivo inválida." })
    .refine((value) => !value.includes(".."), { error: "Ruta de archivo inválida." })
]);

/** Opaque, URL-safe token (base64url). Used for invite, magic-link, reset, verify and chat tickets. */
export const opaqueTokenSchema = z
  .string()
  .trim()
  .min(32, { error: "Enlace inválido o vencido." })
  .max(256, { error: "Enlace inválido o vencido." })
  .regex(/^[A-Za-z0-9_-]+$/, { error: "Enlace inválido o vencido." });

/** Cuencada year as used in public URLs (`/cuencada/:year`). */
export const yearSchema = z.number().int().min(1900).max(2200);

/** Required single-line or multi-line text: trimmed, non-empty, bounded. */
export function requiredTextSchema(max: number): z.ZodString {
  return z
    .string()
    .trim()
    .min(1, { error: "Este campo es obligatorio." })
    .max(max, { error: `Máximo ${max} caracteres.` });
}

/**
 * Optional free text that is stored as `null` when blank.
 * Input: `string | null`; output: trimmed `string` or `null`.
 */
export function nullableTextSchema(max: number): z.ZodType<string | null, string | null> {
  return z
    .string()
    .trim()
    .max(max, { error: `Máximo ${max} caracteres.` })
    .nullable()
    .transform((value) => (value === null || value === "" ? null : value));
}

/**
 * Boolean in a query string. `z.coerce.boolean()` would treat `"false"` as
 * `true`, so only the literals `"true"`/`"false"` are accepted.
 */
export const queryBooleanSchema = z.enum(["true", "false"]).transform((value) => value === "true");

/* -------------------------------------------------------------------------- */
/* Params                                                                      */
/* -------------------------------------------------------------------------- */

/** `:id` path parameter. */
export const idParamSchema = z.object({ id: idSchema });
export type IdParam = z.infer<typeof idParamSchema>;

/** `:year` path parameter (string in the URL, coerced). */
export const yearParamSchema = z.object({ year: z.coerce.number().pipe(yearSchema) });
export type YearParam = z.infer<typeof yearParamSchema>;

/* -------------------------------------------------------------------------- */
/* Cursor pagination                                                           */
/* -------------------------------------------------------------------------- */

export const PAGE_LIMIT_DEFAULT = 20;
export const PAGE_LIMIT_MAX = 100;

/** Opaque keyset cursor produced by the server. Clients must not parse it. */
export const cursorSchema = z
  .string()
  .trim()
  .min(1)
  .max(512)
  .regex(/^[A-Za-z0-9_\-.=]+$/, { error: "Cursor inválido." });

/** Query string for every paginated list endpoint. */
export const cursorQuerySchema = z.object({
  cursor: cursorSchema.exactOptional(),
  limit: z.coerce.number().int().min(1).max(PAGE_LIMIT_MAX).default(PAGE_LIMIT_DEFAULT)
});
export type CursorQuery = z.infer<typeof cursorQuerySchema>;

/** A page of results. `nextCursor` is `null` on the last page. */
export interface Page<TItem> {
  items: TItem[];
  nextCursor: string | null;
}

/** Builds the response schema for a {@link Page} of `item`. */
export function pageSchema<TItem extends z.ZodType>(
  item: TItem
): z.ZodObject<{ items: z.ZodArray<TItem>; nextCursor: z.ZodNullable<z.ZodString> }> {
  return z.object({ items: z.array(item), nextCursor: z.string().nullable() });
}
