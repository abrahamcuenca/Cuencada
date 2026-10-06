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

/** Who may see each optional contact field. All default to hidden. */
export interface ProfileVisibility {
  showEmail: boolean;
  showPhone: boolean;
  showCity: boolean;
}

export const profileVisibilitySchema = z.object({
  showEmail: z.boolean(),
  showPhone: z.boolean(),
  showCity: z.boolean()
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
  city: z.string().max(120).exactOptional()
}) satisfies z.ZodType<DirectoryEntry>;

/** Server-side source row for {@link toDirectoryEntry}: full profile data plus visibility flags. */
export interface DirectoryEntrySource extends Omit<DirectoryEntry, "email" | "phone" | "city"> {
  email: string | null;
  phone: string | null;
  city: string | null;
  visibility: ProfileVisibility;
}

/**
 * Builds the member-facing {@link DirectoryEntry}. Each contact field is
 * **omitted** (key absent, never `undefined`/`null`) unless its `show*` flag
 * is on *and* it has a value. Server mappers must use this helper: the
 * response schema rejects `undefined`/`null` contact values, so a hand-rolled
 * mapper fails closed with a 500 rather than leaking.
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
 */
export const updateProfileInputSchema = z
  .strictObject({
    displayName: displayNameSchema,
    fullName: displayTextSchema(200),
    familyBranch: nullableDisplayTextSchema(120),
    city: nullableDisplayTextSchema(120),
    phone: phoneSchema.nullable(),
    bio: nullableTextSchema(500),
    showEmail: z.boolean(),
    showPhone: z.boolean(),
    showCity: z.boolean()
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
