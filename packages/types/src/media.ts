/**
 * Private photo/video gallery.
 *
 * Upload flow: `createUploadInput` → presigned PUT bound to content type and
 * length → browser PUTs to the bucket → `confirm` (HEAD + magic bytes) →
 * sharp job (rotate, strip EXIF/GPS, 400px thumb, 1600px display).
 * All URLs in responses are presigned GETs valid for 1 hour.
 */
import { z } from "zod";
import {
  cursorQuerySchema,
  dateTimeSchema,
  hasUnsafeChars,
  idSchema,
  nullableTextSchema,
  queryBooleanSchema
} from "./common.js";

const MB = 1024 * 1024;

/* -------------------------------------------------------------------------- */
/* MIME types and limits                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Allowlist of upload MIME types. Anything else is rejected with `UPLOAD_INVALID`.
 * - No HEIC: iOS Safari converts HEIC→JPEG for `<input accept="image/*">`, and
 *   sharp's prebuilt libvips cannot decode HEIC.
 * - `video/quicktime` (.mov) is what iPhones produce; videos are stored as
 *   uploaded (no transcoding), so their `thumbUrl` may be `null`.
 */
export const MediaMimeType = {
  Jpeg: "image/jpeg",
  Png: "image/png",
  Webp: "image/webp",
  Mp4: "video/mp4",
  Quicktime: "video/quicktime"
} as const;
export type MediaMimeType = (typeof MediaMimeType)[keyof typeof MediaMimeType];
export const mediaMimeTypeSchema = z.enum(MediaMimeType, { error: "Tipo de archivo no permitido." });

export const MediaKind = {
  Image: "image",
  Video: "video"
} as const;
export type MediaKind = (typeof MediaKind)[keyof typeof MediaKind];
export const mediaKindSchema = z.enum(MediaKind);

/**
 * Maximum upload size in bytes per media kind. Videos are 150 MB (WP-2.4):
 * the processing job holds a whole video in memory until storage streaming
 * lands, and `server_1` is shared with nine other services. After its resize
 * to 2 GB this may go back to 300 MB (raise the systemd MemoryMax with it); the
 * database CHECK still allows 300 MB, so that needs no migration.
 */
export const MEDIA_SIZE_LIMITS = {
  image: 25 * MB,
  video: 150 * MB
} as const satisfies Record<MediaKind, number>;

/** Avatars are images only and smaller. */
export const AVATAR_MAX_BYTES = 10 * MB;

/** Maps an allowed MIME type to its kind. */
export function mediaKindOfMime(mimeType: MediaMimeType): MediaKind {
  return mimeType.startsWith("video/") ? MediaKind.Video : MediaKind.Image;
}

/** Maximum allowed byte size for an allowed MIME type. */
export function maxBytesForMime(mimeType: MediaMimeType): number {
  return MEDIA_SIZE_LIMITS[mediaKindOfMime(mimeType)];
}

/* -------------------------------------------------------------------------- */
/* Statuses                                                                    */
/* -------------------------------------------------------------------------- */

/** Lifecycle of the stored object. Only `ready` items appear in member lists. */
export const MediaUploadStatus = {
  PendingUpload: "pending_upload",
  Processing: "processing",
  Ready: "ready",
  Failed: "failed"
} as const;
export type MediaUploadStatus = (typeof MediaUploadStatus)[keyof typeof MediaUploadStatus];
export const mediaUploadStatusSchema = z.enum(MediaUploadStatus);

/** Moderation state. Default is `approved` (auto-approve) unless the approval-first flag is on. */
export const ModerationStatus = {
  PendingReview: "pending_review",
  Approved: "approved",
  Hidden: "hidden"
} as const;
export type ModerationStatus = (typeof ModerationStatus)[keyof typeof ModerationStatus];
export const moderationStatusSchema = z.enum(ModerationStatus);

export const MediaReportReason = {
  Inappropriate: "inappropriate",
  Privacy: "privacy",
  Duplicate: "duplicate",
  Other: "other"
} as const;
export type MediaReportReason = (typeof MediaReportReason)[keyof typeof MediaReportReason];
export const mediaReportReasonSchema = z.enum(MediaReportReason);

export const MediaModerationAction = {
  Approve: "approve",
  Hide: "hide",
  Delete: "delete"
} as const;
export type MediaModerationAction = (typeof MediaModerationAction)[keyof typeof MediaModerationAction];
export const mediaModerationActionSchema = z.enum(MediaModerationAction);

/* -------------------------------------------------------------------------- */
/* Upload                                                                      */
/* -------------------------------------------------------------------------- */

/** Original file name, for display only. The object key is always server-generated. */
export const fileNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .normalize("NFC")
  .refine((value) => !hasPathOrControlChars(value) && !hasUnsafeChars(value), { error: "Nombre de archivo inválido." });

function hasPathOrControlChars(value: string): boolean {
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code < 0x20 || code === 0x7f || char === "/" || char === "\\") return true;
  }
  return false;
}

export const mediaCaptionSchema = nullableTextSchema(500);

/** `POST /api/cuencadas/:year/media/uploads` body. */
export const createUploadInputSchema = z
  .object({
    fileName: fileNameSchema,
    mimeType: mediaMimeTypeSchema,
    byteSize: z.number().int().positive({ error: "El archivo está vacío." }),
    caption: mediaCaptionSchema.default(null)
  })
  .superRefine((value, ctx) => {
    const max = maxBytesForMime(value.mimeType);
    if (value.byteSize > max) {
      ctx.addIssue({
        code: "custom",
        path: ["byteSize"],
        message: `El archivo supera el máximo de ${Math.round(max / MB)} MB.`
      });
    }
  });
export type CreateUploadInput = z.infer<typeof createUploadInputSchema>;
export type CreateUploadRequest = z.input<typeof createUploadInputSchema>;

/**
 * Presigned PUT. The client must send exactly `headers` before `expiresAt`.
 * `headers` holds only browser-settable headers (`Content-Type`, plus any
 * `x-amz-*` the server signs). `Content-Length` is also part of the signature
 * (from `byteSize`) but is never listed: browsers set it from the `File`.
 */
export interface CreateUploadResponse {
  mediaId: string;
  uploadUrl: string;
  headers: Record<string, string>;
  expiresAt: string;
}

export const createUploadResponseSchema = z.object({
  mediaId: idSchema,
  uploadUrl: z.string().max(4096),
  headers: z.record(z.string().max(100), z.string().max(1024)),
  expiresAt: dateTimeSchema
}) satisfies z.ZodType<CreateUploadResponse>;

/**
 * `POST /api/media/:id/confirm` body. Send no body or `{}`; any key is rejected
 * (reserved for a future checksum). Fastify validates a missing body as
 * `null`, so both `null` and `undefined` are accepted.
 */
export const confirmUploadInputSchema = z.strictObject({}).nullish();
export type ConfirmUploadInput = z.infer<typeof confirmUploadInputSchema>;
export type ConfirmUploadRequest = z.input<typeof confirmUploadInputSchema>;

/* -------------------------------------------------------------------------- */
/* Items                                                                       */
/* -------------------------------------------------------------------------- */

/** A gallery item as members see it. */
export interface MediaItem {
  id: string;
  cuencadaId: string;
  year: number;
  kind: MediaKind;
  mimeType: MediaMimeType;
  /** Presigned 400px WebP (1h). `null` until processed. */
  thumbUrl: string | null;
  /** Presigned 1600px WebP, or the MP4 for videos (1h). `null` until processed. */
  displayUrl: string | null;
  width: number | null;
  height: number | null;
  durationSeconds: number | null;
  caption: string | null;
  uploaderName: string | null;
  /** True when the caller uploaded it. */
  isMine: boolean;
  /** Server-computed: the caller may edit the caption (uploader or admin). */
  canEdit: boolean;
  /** Server-computed: the caller may delete the item (uploader or admin). */
  canDelete: boolean;
  uploadStatus: MediaUploadStatus;
  moderationStatus: ModerationStatus;
  createdAt: string;
}

export const mediaItemSchema = z.object({
  id: idSchema,
  cuencadaId: idSchema,
  year: z.number().int(),
  kind: mediaKindSchema,
  mimeType: mediaMimeTypeSchema,
  thumbUrl: z.string().max(4096).nullable(),
  displayUrl: z.string().max(4096).nullable(),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  durationSeconds: z.number().nullable(),
  caption: z.string().max(500).nullable(),
  uploaderName: z.string().max(80).nullable(),
  isMine: z.boolean(),
  canEdit: z.boolean(),
  canDelete: z.boolean(),
  uploadStatus: mediaUploadStatusSchema,
  moderationStatus: moderationStatusSchema,
  createdAt: dateTimeSchema
}) satisfies z.ZodType<MediaItem>;

/** `GET /api/cuencadas/:year/media` query. */
export const mediaListQuerySchema = cursorQuerySchema.extend({
  kind: mediaKindSchema.exactOptional()
});
export type MediaListQuery = z.infer<typeof mediaListQuerySchema>;
export type MediaListQueryRequest = z.input<typeof mediaListQuerySchema>;

/** `PATCH /api/media/:id` body (uploader or admin). */
export const updateMediaInputSchema = z.object({ caption: mediaCaptionSchema });
export type UpdateMediaInput = z.infer<typeof updateMediaInputSchema>;
export type UpdateMediaRequest = z.input<typeof updateMediaInputSchema>;

/** `POST /api/media/:id/report` body. One open report per user per item. */
export const reportMediaInputSchema = z.object({
  reason: mediaReportReasonSchema,
  details: nullableTextSchema(500).default(null)
});
export type ReportMediaInput = z.infer<typeof reportMediaInputSchema>;
export type ReportMediaRequest = z.input<typeof reportMediaInputSchema>;

/* -------------------------------------------------------------------------- */
/* Admin moderation                                                            */
/* -------------------------------------------------------------------------- */

export interface MediaReport {
  id: string;
  reason: MediaReportReason;
  details: string | null;
  reporterName: string | null;
  createdAt: string;
}

export const mediaReportSchema = z.object({
  id: idSchema,
  reason: mediaReportReasonSchema,
  details: z.string().max(500).nullable(),
  reporterName: z.string().max(80).nullable(),
  createdAt: dateTimeSchema
}) satisfies z.ZodType<MediaReport>;

/** Media as seen in the admin moderation queue. */
export interface AdminMediaItem extends MediaItem {
  uploaderUserId: string | null;
  fileName: string;
  byteSize: number;
  reportCount: number;
  moderatedAt: string | null;
  moderatedByName: string | null;
  moderationNote: string | null;
}

export const adminMediaItemSchema = mediaItemSchema.extend({
  uploaderUserId: idSchema.nullable(),
  fileName: z.string().max(255),
  byteSize: z.number().int(),
  reportCount: z.number().int(),
  moderatedAt: dateTimeSchema.nullable(),
  moderatedByName: z.string().max(80).nullable(),
  moderationNote: z.string().max(500).nullable()
}) satisfies z.ZodType<AdminMediaItem>;

/** `GET /api/admin/media` query. */
export const adminMediaQuerySchema = cursorQuerySchema.extend({
  moderationStatus: moderationStatusSchema.exactOptional(),
  uploadStatus: mediaUploadStatusSchema.exactOptional(),
  cuencadaId: idSchema.exactOptional(),
  /** `"true"` → only items with at least one report. */
  reported: queryBooleanSchema.exactOptional()
});
export type AdminMediaQuery = z.infer<typeof adminMediaQuerySchema>;
export type AdminMediaQueryRequest = z.input<typeof adminMediaQuerySchema>;

/** `POST /api/admin/media/:id/moderate` body. `delete` is a soft delete. */
export const moderateMediaInputSchema = z.object({
  action: mediaModerationActionSchema,
  note: nullableTextSchema(500).default(null)
});
export type ModerateMediaInput = z.infer<typeof moderateMediaInputSchema>;
export type ModerateMediaRequest = z.input<typeof moderateMediaInputSchema>;
