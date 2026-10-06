/**
 * Gallery media (member-only) and member reports. Object keys are always
 * server-generated; URLs are presigned on read.
 */
import {
  MediaKind,
  MediaMimeType,
  MediaReportReason,
  MediaUploadStatus,
  ModerationStatus
} from "@cuencada/types";
import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { users } from "./auth.js";
import { cuencadas } from "./cuencadas.js";
import { checkIn, createdAt, timestamptz, updatedAt } from "./helpers.js";

/**
 * Database bound on `byte_size` (300 MB, as created by migration 0001). It is
 * deliberately looser than the contract's `MEDIA_SIZE_LIMITS` (videos 150 MB
 * since WP-2.4), so the app cap can move without a migration. Keep it a
 * literal so the schema never drifts from the migrations.
 */
const MEDIA_MAX_BYTES = 300 * 1024 * 1024;

export const mediaItems = pgTable(
  "media_items",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    cuencadaId: uuid("cuencada_id")
      .notNull()
      .references(() => cuencadas.id, { onDelete: "cascade" }),
    uploadedByUserId: uuid("uploaded_by_user_id").references(() => users.id, { onDelete: "set null" }),
    kind: text("kind").$type<MediaKind>().notNull(),
    /** Original upload key. */
    objectKey: text("object_key").notNull(),
    bucket: text("bucket").notNull(),
    /** 400px WebP derivative. */
    thumbKey: text("thumb_key"),
    /** 1600px WebP derivative, or the MP4 for videos. */
    displayKey: text("display_key"),
    fileName: text("file_name").notNull(),
    mimeType: text("mime_type").$type<MediaMimeType>().notNull(),
    byteSize: integer("byte_size").notNull(),
    width: integer("width"),
    height: integer("height"),
    durationSeconds: integer("duration_seconds"),
    caption: text("caption"),
    uploadStatus: text("upload_status").$type<MediaUploadStatus>().notNull().default("pending_upload"),
    /** Upload URL expiry; stale `pending_upload` rows are cleaned up after it. */
    uploadExpiresAt: timestamptz("upload_expires_at"),
    confirmedAt: timestamptz("confirmed_at"),
    processedAt: timestamptz("processed_at"),
    /** Internal failure reason; never returned to members. */
    processingError: text("processing_error"),
    /** `approved` by default; the service sets `pending_review` when `MEDIA_REQUIRE_APPROVAL` is on. */
    moderationStatus: text("moderation_status").$type<ModerationStatus>().notNull().default("approved"),
    moderatedAt: timestamptz("moderated_at"),
    moderatedByUserId: uuid("moderated_by_user_id").references(() => users.id, { onDelete: "set null" }),
    moderationNote: text("moderation_note"),
    deletedAt: timestamptz("deleted_at"),
    deletedByUserId: uuid("deleted_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  },
  (table) => [
    uniqueIndex("media_items_object_key_unique").on(table.objectKey),
    // Gallery keyset pagination (newest first), live rows only.
    index("media_items_gallery_keyset_idx")
      .on(table.cuencadaId, table.createdAt.desc(), table.id.desc())
      .where(sql`deleted_at is null`),
    index("media_items_uploaded_by_user_id_idx").on(table.uploadedByUserId),
    index("media_items_moderated_by_user_id_idx").on(table.moderatedByUserId),
    index("media_items_deleted_by_user_id_idx").on(table.deletedByUserId),
    index("media_items_moderation_queue_idx").on(table.moderationStatus, table.uploadStatus, table.createdAt),
    checkIn("media_items_kind_check", "kind", MediaKind),
    checkIn("media_items_mime_type_check", "mime_type", MediaMimeType),
    checkIn("media_items_upload_status_check", "upload_status", MediaUploadStatus),
    checkIn("media_items_moderation_status_check", "moderation_status", ModerationStatus),
    check("media_items_byte_size_check", sql.raw(`"byte_size" > 0 and "byte_size" <= ${MEDIA_MAX_BYTES}`)),
    check(
      "media_items_dimensions_check",
      sql`("width" is null or "width" > 0) and ("height" is null or "height" > 0) and ("duration_seconds" is null or "duration_seconds" >= 0)`
    ),
    check(
      "media_items_kind_mime_check",
      sql`("kind" = 'video') = ("mime_type" like 'video/%')`
    )
  ]
);

/** A member's report on a media item; one per (media, reporter). */
export const mediaReports = pgTable(
  "media_reports",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    mediaId: uuid("media_id")
      .notNull()
      .references(() => mediaItems.id, { onDelete: "cascade" }),
    reporterUserId: uuid("reporter_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    reason: text("reason").$type<MediaReportReason>().notNull(),
    details: text("details"),
    createdAt: createdAt()
  },
  (table) => [
    uniqueIndex("media_reports_media_reporter_unique").on(table.mediaId, table.reporterUserId),
    index("media_reports_reporter_user_id_idx").on(table.reporterUserId),
    checkIn("media_reports_reason_check", "reason", MediaReportReason),
    check("media_reports_details_length_check", sql`"details" is null or char_length("details") <= 500`)
  ]
);
