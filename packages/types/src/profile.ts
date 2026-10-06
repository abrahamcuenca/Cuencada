/**
 * Own profile and the member directory.
 *
 * PII rule: `DirectoryEntry` is the only shape another member ever receives.
 * Contact fields (`email`, `phone`, `city`) are *absent* (not `null`) unless
 * the owner's visibility flag allows them. The server serializes directory
 * responses through `directoryEntrySchema`, which strips anything else.
 */
import { z } from "zod";
import { cursorQuerySchema, dateTimeSchema, idSchema, nullableTextSchema, requiredTextSchema } from "./common.js";
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

/** Phone as typed by family members: digits, spaces, `+ ( ) -`. */
export const phoneSchema = z
  .string()
  .trim()
  .max(30)
  .regex(/^\+?[0-9 ()-]{7,29}$/, { error: "Teléfono inválido." });

/** `PATCH /api/profile/me`. Send only the fields that change; `null` clears. */
export const updateProfileInputSchema = z
  .object({
    displayName: displayNameSchema,
    fullName: requiredTextSchema(200),
    familyBranch: nullableTextSchema(120),
    city: nullableTextSchema(120),
    phone: phoneSchema.nullable(),
    bio: nullableTextSchema(500),
    showEmail: z.boolean(),
    showPhone: z.boolean(),
    showCity: z.boolean()
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, { error: "No hay cambios que guardar." });
export type UpdateProfileInput = z.infer<typeof updateProfileInputSchema>;

/** `GET /api/directory` query. */
export const directoryQuerySchema = cursorQuerySchema.extend({
  q: z.string().trim().max(100).exactOptional(),
  familyBranch: z.string().trim().max(120).exactOptional()
});
export type DirectoryQuery = z.infer<typeof directoryQuerySchema>;

/* -------------------------------------------------------------------------- */
/* Avatar                                                                      */
/* -------------------------------------------------------------------------- */

export const avatarMimeTypeSchema = z.enum(
  [MediaMimeType.Jpeg, MediaMimeType.Png, MediaMimeType.Webp, MediaMimeType.Heic],
  { error: "La foto debe ser JPG, PNG, WebP o HEIC." }
);

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
