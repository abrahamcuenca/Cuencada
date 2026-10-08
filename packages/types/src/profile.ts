/**
 * Own profile and the member directory.
 *
 * PII rule: `DirectoryEntry` is the only shape another member ever receives.
 * Contact fields (`email`, `phone`, `city`) are *absent* (not `null`) unless
 * the owner's visibility flag allows them. The server serializes directory
 * responses through `directoryEntrySchema`, which strips anything else.
 */
import { z } from "zod";
import {
  cursorQuerySchema,
  dateTimeSchema,
  displayTextSchema,
  idSchema,
  nullableDisplayTextSchema,
  nullableTextSchema
} from "./common.js";
import { displayNameSchema } from "./auth.js";
import { AVATAR_MAX_BYTES, MediaMimeType } from "./media.js";
import { type ContactCard, type OwnContacts, contactCardSchema, e164PhoneSchema, ownContactsSchema } from "./contacts.js";

// WP-4.0: contact contracts live in their own file; re-exported here because
// the `index.ts` barrel is frozen.
export * from "./contacts.js";

/**
 * Who may see each optional contact field (all default to hidden), and
 * whether the member appears in member-facing lists at all.
 */
export interface ProfileVisibility {
  showEmail: boolean;
  showPhone: boolean;
  showCity: boolean;
  /**
   * "Aparecer en el directorio" (`profiles.listed_in_directory`, default `true`,
   * WP-2.1). When `false` the member is left out of `GET /api/directory` and is
   * shown anonymously (no name, avatar or ids) in attendee lists, except to
   * themselves. Enforced by the queries, not by {@link toDirectoryEntry}.
   */
  listedInDirectory: boolean;
}

export const profileVisibilitySchema = z.object({
  showEmail: z.boolean(),
  showPhone: z.boolean(),
  showCity: z.boolean(),
  listedInDirectory: z.boolean()
}) satisfies z.ZodType<ProfileVisibility>;

/** The caller's own full profile (`GET /api/profile/me`). */
export interface OwnProfile {
  userId: string;
  personId: string | null;
  email: string;
  displayName: string;
  fullName: string;
  familyBranch: string | null;
  city: string | null;
  phone: string | null;
  bio: string | null;
  avatarUrl: string | null;
  visibility: ProfileVisibility;
  /**
   * Social contacts and per-field visibility (WP-4.0 contract, filled from
   * WP-4.4). Optional so responses from servers before WP-4.4 still parse.
   */
  contacts?: OwnContacts;
  updatedAt: string;
}

export const ownProfileSchema = z.object({
  userId: idSchema,
  personId: idSchema.nullable(),
  email: z.string().max(254),
  displayName: z.string().max(80),
  fullName: z.string().max(200),
  familyBranch: z.string().max(120).nullable(),
  city: z.string().max(120).nullable(),
  phone: z.string().max(30).nullable(),
  bio: z.string().max(500).nullable(),
  avatarUrl: z.string().max(4096).nullable(),
  visibility: profileVisibilitySchema,
  contacts: ownContactsSchema.exactOptional(),
  updatedAt: dateTimeSchema
}) satisfies z.ZodType<OwnProfile>;

/**
 * A member as seen by other members (`GET /api/directory`).
 * Optional contact fields are present only when the owner opted in.
 */
export interface DirectoryEntry {
  userId: string;
  personId: string | null;
  displayName: string;
  fullName: string;
  familyBranch: string | null;
  avatarUrl: string | null;
  bio: string | null;
  email?: string;
  phone?: string;
  city?: string;
  /**
   * Visible contacts as server-built links (WP-4.0 contract, filled from
   * WP-4.4 by `buildContactCard`). Absent from older servers; an empty array
   * when nothing is visible.
   */
  contacts?: ContactCard;
}

export const directoryEntrySchema = z.object({
  userId: idSchema,
  personId: idSchema.nullable(),
  displayName: z.string().max(80),
  fullName: z.string().max(200),
  familyBranch: z.string().max(120).nullable(),
  avatarUrl: z.string().max(4096).nullable(),
  bio: z.string().max(500).nullable(),
  email: z.string().max(254).exactOptional(),
  phone: z.string().max(30).exactOptional(),
  city: z.string().max(120).exactOptional(),
  contacts: contactCardSchema.exactOptional()
}) satisfies z.ZodType<DirectoryEntry>;

/**
 * Server-side source row for {@link toDirectoryEntry}: full profile data plus
 * the contact visibility flags. `listedInDirectory` is not needed here: the
 * directory query filters unlisted members out before mapping.
 */
export interface DirectoryEntrySource extends Omit<DirectoryEntry, "email" | "phone" | "city" | "contacts"> {
  email: string | null;
  phone: string | null;
  city: string | null;
  visibility: Pick<ProfileVisibility, "showEmail" | "showPhone" | "showCity">;
}

/**
 * Builds the member-facing {@link DirectoryEntry}. Each contact field is
 * **omitted** (key absent, never `undefined`/`null`) unless its `show*` flag
 * is on *and* it has a value. Server mappers must use this helper: the
 * response schema rejects `undefined`/`null` contact values, so a hand-rolled
 * mapper fails closed with a 500 rather than leaking.
 *
 * It does not look at `visibility.listedInDirectory`: unlisted members must be
 * filtered out by the directory query itself (`where listed_in_directory`), so
 * they never reach this helper, nor count in pagination or search results.
 */
export function toDirectoryEntry(source: DirectoryEntrySource): DirectoryEntry {
  const entry: DirectoryEntry = {
    userId: source.userId,
    personId: source.personId,
    displayName: source.displayName,
    fullName: source.fullName,
    familyBranch: source.familyBranch,
    avatarUrl: source.avatarUrl,
    bio: source.bio
  };
  if (source.visibility.showEmail && source.email !== null) entry.email = source.email;
  if (source.visibility.showPhone && source.phone !== null) entry.phone = source.phone;
  if (source.visibility.showCity && source.city !== null) entry.city = source.city;
  return entry;
}

/** E.164 allows at most 15 digits; fewer than 7 is not a reachable phone number. */
export const PHONE_MIN_DIGITS = 7;
export const PHONE_MAX_DIGITS = 15;

/**
 * Phone as typed by family members: an optional leading `+`, then digits,
 * spaces and `( ) -`, with 7–15 digits in total (E.164-ish, length-bounded).
 */
export const phoneSchema = z
  .string()
  .trim()
  .max(30)
  .regex(/^\+?[0-9 ()-]{7,29}$/, { error: "Teléfono inválido." })
  .refine(
    (value) => {
      const digits = value.replace(/\D/g, "").length;
      return digits >= PHONE_MIN_DIGITS && digits <= PHONE_MAX_DIGITS;
    },
    { error: "El teléfono debe tener entre 7 y 15 dígitos." }
  );

/**
 * `PATCH /api/profile/me`. Send only the fields that change; `null` clears.
 * Strict: any other key (`role`, `status`, `userId`, `email`, …) is a 400
 * `VALIDATION`, so mass assignment fails loudly instead of being ignored.
 *
 * `phone` is **deprecated here** (WP-4.0 decision): the web edits it through
 * `PATCH /api/profile/me/contacts`. It is still accepted for older PWA
 * clients, normalized with the same E.164 rules (`e164PhoneSchema`), so both
 * paths store the same value. Blank or `null` clears.
 */
export const updateProfileInputSchema = z
  .strictObject({
    displayName: displayNameSchema,
    fullName: displayTextSchema(200),
    familyBranch: nullableDisplayTextSchema(120),
    city: nullableDisplayTextSchema(120),
    phone: e164PhoneSchema,
    bio: nullableTextSchema(500),
    showEmail: z.boolean(),
    showPhone: z.boolean(),
    showCity: z.boolean(),
    listedInDirectory: z.boolean()
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, { error: "No hay cambios que guardar." });
export type UpdateProfileInput = z.infer<typeof updateProfileInputSchema>;
export type UpdateProfileRequest = z.input<typeof updateProfileInputSchema>;

/**
 * `GET /api/directory` query. The server must match `q` only against fields
 * the target member has made visible, otherwise search becomes an oracle for
 * hidden contact data. The server matches displayName, fullName, the linked
 * person's nickname and familyBranch always, city only when `showCity` is on,
 * and **never** email or phone (even when shown). Blank `q` means no filter.
 */
export const directoryQuerySchema = cursorQuerySchema.extend({
  q: z.string().normalize("NFC").trim().max(100).exactOptional(),
  familyBranch: z.string().normalize("NFC").trim().max(120).exactOptional(),
  /** Exact (case-insensitive) city; only matches members with `showCity` on. */
  city: z.string().normalize("NFC").trim().max(120).exactOptional()
});
export type DirectoryQuery = z.infer<typeof directoryQuerySchema>;
export type DirectoryQueryRequest = z.input<typeof directoryQuerySchema>;

/* -------------------------------------------------------------------------- */
/* Avatar                                                                      */
/* -------------------------------------------------------------------------- */

export const avatarMimeTypeSchema = z.enum([MediaMimeType.Jpeg, MediaMimeType.Png, MediaMimeType.Webp], {
  error: "La foto debe ser JPG, PNG o WebP."
});

/** `POST /api/profile/me/avatar/uploads` body. */
export const avatarUploadInputSchema = z.object({
  mimeType: avatarMimeTypeSchema,
  byteSize: z
    .number()
    .int()
    .positive({ error: "El archivo está vacío." })
    .max(AVATAR_MAX_BYTES, { error: "La foto supera el máximo de 10 MB." })
});
export type AvatarUploadInput = z.infer<typeof avatarUploadInputSchema>;
export type AvatarUploadRequest = z.input<typeof avatarUploadInputSchema>;

/** Presigned PUT for an avatar (same mechanics as gallery uploads). */
export interface AvatarUploadResponse {
  uploadId: string;
  uploadUrl: string;
  headers: Record<string, string>;
  expiresAt: string;
}

export const avatarUploadResponseSchema = z.object({
  uploadId: idSchema,
  uploadUrl: z.string().max(4096),
  headers: z.record(z.string().max(100), z.string().max(1024)),
  expiresAt: dateTimeSchema
}) satisfies z.ZodType<AvatarUploadResponse>;

/** `POST /api/profile/me/avatar/confirm` body. Responds with the updated `OwnProfile`. */
export const avatarConfirmInputSchema = z.object({ uploadId: idSchema });
export type AvatarConfirmInput = z.infer<typeof avatarConfirmInputSchema>;
export type AvatarConfirmRequest = z.input<typeof avatarConfirmInputSchema>;

/* -------------------------------------------------------------------------- */
/* Image crop (WP-4.0: person photos; avatars may adopt it in WP-4.3)          */
/* -------------------------------------------------------------------------- */

/** Largest coordinate or side accepted in a crop rect (above the 24 MP decode cap's longest side). */
export const IMAGE_CROP_MAX_PX = 30_000;

/**
 * Optional square crop in **source pixels** (after EXIF orientation), for a
 * server-side `sharp().extract()`. The web normally crops client-side (the
 * `ImageCropper` exports a 1024×1024 JPEG) and omits it; it exists for
 * clients that upload the original. Integers ≥ 0, `size` ≥ 1. The server must
 * clamp it to the decoded image with {@link clampCropRect}, never trust it.
 */
export interface ImageCropRect {
  x: number;
  y: number;
  size: number;
}

const cropCoordinate = z
  .number()
  .int({ error: "Recorte inválido." })
  .min(0, { error: "Recorte inválido." })
  .max(IMAGE_CROP_MAX_PX, { error: "Recorte inválido." });

export const imageCropRectSchema = z.strictObject({
  x: cropCoordinate,
  y: cropCoordinate,
  size: cropCoordinate.min(1, { error: "Recorte inválido." })
}) satisfies z.ZodType<ImageCropRect>;

/** A crop clamped to an image, in `sharp().extract()` terms. */
export interface ClampedCrop {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Clamps `rect` to a `width × height` image so `extract()` never reads out of
 * bounds, keeping the user's framing as far as possible: the side is capped at
 * the image's shorter dimension (`min(size, width, height)`, ≥ 1), then the
 * origin is **shifted** back inside (`left ∈ [0, width − side]`,
 * `top ∈ [0, height − side]`) rather than shrinking the square.
 *
 * @param rect - Crop parsed by {@link imageCropRectSchema}.
 * @param width - Image width in pixels after EXIF rotation (integer ≥ 1).
 * @param height - Image height in pixels after EXIF rotation (integer ≥ 1).
 * @returns The square region to extract.
 * @throws RangeError when the image dimensions are not positive integers, or
 *   a rect value is not a finite number (direct callers that skipped the schema).
 */
export function clampCropRect(rect: ImageCropRect, width: number, height: number): ClampedCrop {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new RangeError("clampCropRect: invalid image dimensions");
  }
  if (!Number.isFinite(rect.x) || !Number.isFinite(rect.y) || !Number.isFinite(rect.size)) {
    throw new RangeError("clampCropRect: invalid crop rect");
  }
  const side = Math.max(1, Math.min(Math.trunc(rect.size), width, height));
  const left = Math.min(Math.max(0, Math.trunc(rect.x)), width - side);
  const top = Math.min(Math.max(0, Math.trunc(rect.y)), height - side);
  return { left, top, width: side, height: side };
}
