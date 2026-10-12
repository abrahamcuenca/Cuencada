/**
 * Gallery media (member-only) and member reports. Object keys are always
 * server-generated; URLs are presigned on read. Each item belongs to exactly
 * one scope: an edition (`cuencada_id`), an event album (`album_id`, WP-5.2)
 * or a Memory Box (`memory_album_id`, WP-6.0, migration 0010).
 */
import {
  MEMORY_ALBUM_DESCRIPTION_MAX_LENGTH,
  MEMORY_ALBUM_SORT_ORDER_MAX,
  MEMORY_ALBUM_TITLE_MAX_LENGTH,
  MediaKind,
  MediaMimeType,
  MediaReportReason,
  MediaUploadStatus,
  MemoryAlbumStatus,
  ModerationStatus
} from "@cuencada/types";
import { sql } from "drizzle-orm";
import { type AnyPgColumn, check, index, integer, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { users } from "./auth.js";
import { cuencadas } from "./cuencadas.js";
import { eventAlbums } from "./events.js";
import { checkIn, createdAt, timestamptz, updatedAt } from "./helpers.js";

/**
 * Database bound on `byte_size` (300 MB, as created by migration 0001). It is
 * deliberately looser than the contract's `MEDIA_SIZE_LIMITS` (videos 150 MB
 * since WP-2.4), so the app cap can move without a migration. Keep it a
 * literal so the schema never drifts from the migrations.
 */
const MEDIA_MAX_BYTES = 300 * 1024 * 1024;

/** Lowercase canonical uuid, as the storage-prefix CHECK matches it. */
const UUID_RE = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

/**
 * Memory Box ("Baúl de recuerdos", WP-6.0, migration 0010): an admin-created
 * album that belongs to no edition and no event. Its media are `media_items`
 * rows with `memory_album_id` set and `storage_prefix = memories/{id}`
 * (`media_items_memory_prefix_check`). Defined here, not in its own module,
 * because the two tables reference each other (`cover_media_id`).
 */
export const memoryAlbums = pgTable(
  "memory_albums",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    title: text("title").notNull(),
    description: text("description"),
    /** A media item of this box shown on the card; the service checks it belongs to the box. */
    coverMediaId: uuid("cover_media_id").references((): AnyPgColumn => mediaItems.id, { onDelete: "set null" }),
    sortOrder: integer("sort_order").notNull().default(0),
    status: text("status").$type<MemoryAlbumStatus>().notNull().default("draft"),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  },
  (table) => [
    // Member list: published boxes by sort order.
    index("memory_albums_status_sort_idx").on(table.status, table.sortOrder, table.createdAt),
    index("memory_albums_cover_media_id_idx").on(table.coverMediaId),
    index("memory_albums_created_by_user_id_idx").on(table.createdByUserId),
    check(
      "memory_albums_title_length_check",
      sql.raw(`char_length("title") between 1 and ${MEMORY_ALBUM_TITLE_MAX_LENGTH}`)
    ),
    check(
      "memory_albums_description_length_check",
      sql.raw(`"description" is null or char_length("description") <= ${MEMORY_ALBUM_DESCRIPTION_MAX_LENGTH}`)
    ),
    check("memory_albums_sort_order_check", sql.raw(`"sort_order" between 0 and ${MEMORY_ALBUM_SORT_ORDER_MAX}`)),
    checkIn("memory_albums_status_check", "status", MemoryAlbumStatus)
  ]
);

export const mediaItems = pgTable(
  "media_items",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    /** Edition scope; `null` for event-album media (nullable since WP-5.2, `media_items_scope_check`). */
    cuencadaId: uuid("cuencada_id").references(() => cuencadas.id, { onDelete: "cascade" }),
    /**
     * WP-5.2 event-album scope. ON DELETE RESTRICT: an album (and its event)
     * cannot be deleted while any media row, soft-deleted ones included,
     * points at it; the service deletes the rows (and objects) first.
     */
    albumId: uuid("album_id").references(() => eventAlbums.id, { onDelete: "restrict" }),
    /**
     * WP-6.0 Memory Box scope. ON DELETE RESTRICT for the same reason as
     * `album_id`: deleting a box needs its media rows (and objects) removed first.
     */
    memoryAlbumId: uuid("memory_album_id").references((): AnyPgColumn => memoryAlbums.id, { onDelete: "restrict" }),
    /**
     * WP-5.2: server-generated key prefix (`cuencadas/{year}`,
     * `events/{eventId}/{albumId}` or, WP-6.0, `memories/{memoryAlbumId}`), so
     * keys survive an edition's year change. `null` on legacy edition rows,
     * whose prefix is `cuencadas/{year}`; required for album and box rows
     * (`media_items_storage_prefix_check`, `media_items_memory_prefix_check`).
     */
    storagePrefix: text("storage_prefix"),
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
    // Album keyset pagination (newest first); also serves the RESTRICT check on album delete.
    index("media_items_album_keyset_idx")
      .on(table.albumId, table.createdAt.desc(), table.id.desc())
      .where(sql`album_id is not null`),
    // WP-6.0: Memory Box keyset pagination; also serves the RESTRICT check on box delete.
    index("media_items_memory_keyset_idx")
      .on(table.memoryAlbumId, table.createdAt.desc(), table.id.desc())
      .where(sql`memory_album_id is not null`),
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
    ),
    check("media_items_scope_check", sql`num_nonnulls("cuencada_id", "album_id", "memory_album_id") = 1`),
    check(
      "media_items_storage_prefix_check",
      sql.raw(
        `(("album_id" is null and "memory_album_id" is null) or "storage_prefix" is not null) and ("storage_prefix" is null or "storage_prefix" ~ '^(cuencadas/[0-9]{4}|events/${UUID_RE}/${UUID_RE}|memories/${UUID_RE})$')`
      )
    ),
    // WP-6.0: a box row's prefix is exactly its own box (keys can never point at another box).
    check(
      "media_items_memory_prefix_check",
      sql`"memory_album_id" is null or "storage_prefix" = ('memories/' || "memory_album_id"::text)`
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
