/**
 * Photo social features (WP-6.0, migration 0010): people tags, hearts and
 * comments on `media_items`, plus comment reports. Every row hangs off a
 * media item and inherits its scope: routes load the item through the media
 * scope first (ADR 0001 §8). WP-6.2 implements the routes.
 */
import { MEDIA_COMMENT_MAX_LENGTH, MediaReportReason } from "@cuencada/types";
import { sql } from "drizzle-orm";
import { check, index, numeric, pgTable, primaryKey, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { users } from "./auth.js";
import { checkIn, createdAt, timestamptz } from "./helpers.js";
import { mediaItems } from "./media.js";
import { people } from "./people.js";

/**
 * A person (tree node, with or without an account) tagged in a media item.
 * One tag per person per item. `x`/`y` are an optional position (fractions
 * of the image, both or neither). A person delete removes their tags; a
 * person merge moves them first (WP-6.2).
 */
export const mediaTags = pgTable(
  "media_tags",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    mediaId: uuid("media_id")
      .notNull()
      .references(() => mediaItems.id, { onDelete: "cascade" }),
    personId: uuid("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    /** Who tagged; `null` once that account is removed. */
    taggedByUserId: uuid("tagged_by_user_id").references(() => users.id, { onDelete: "set null" }),
    x: numeric("x", { precision: 5, scale: 4 }),
    y: numeric("y", { precision: 5, scale: 4 }),
    createdAt: createdAt()
  },
  (table) => [
    uniqueIndex("media_tags_media_person_unique").on(table.mediaId, table.personId),
    // "Fotos de {persona}" and person merge/delete.
    index("media_tags_person_id_idx").on(table.personId),
    index("media_tags_tagged_by_user_id_idx").on(table.taggedByUserId),
    check(
      "media_tags_position_check",
      sql`("x" is null) = ("y" is null) and ("x" is null or ("x" between 0 and 1 and "y" between 0 and 1))`
    )
  ]
);

/** A heart: one per member per item. */
export const mediaLikes = pgTable(
  "media_likes",
  {
    mediaId: uuid("media_id")
      .notNull()
      .references(() => mediaItems.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: createdAt()
  },
  (table) => [
    primaryKey({ name: "media_likes_pkey", columns: [table.mediaId, table.userId] }),
    index("media_likes_user_id_idx").on(table.userId)
  ]
);

/**
 * A comment on a media item. Deleting (author or admin) keeps the row as a
 * tombstone: `deleted_at` set and the body **scrubbed** to `''` (the CHECK
 * allows an empty body only on deleted rows), so a deleted text can never be
 * returned or leaked later. `client_comment_id` makes retries idempotent.
 */
export const mediaComments = pgTable(
  "media_comments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    mediaId: uuid("media_id")
      .notNull()
      .references(() => mediaItems.id, { onDelete: "cascade" }),
    /** `null` once the author's account is removed (the comment stays). */
    authorUserId: uuid("author_user_id").references(() => users.id, { onDelete: "set null" }),
    body: text("body").notNull(),
    clientCommentId: uuid("client_comment_id"),
    deletedAt: timestamptz("deleted_at"),
    deletedByUserId: uuid("deleted_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt()
  },
  (table) => [
    // Comment pages (oldest first) and counts per item.
    index("media_comments_media_keyset_idx").on(table.mediaId, table.createdAt, table.id),
    index("media_comments_author_user_id_idx").on(table.authorUserId),
    index("media_comments_deleted_by_user_id_idx").on(table.deletedByUserId),
    uniqueIndex("media_comments_author_client_id_unique")
      .on(table.authorUserId, table.clientCommentId)
      .where(sql`client_comment_id is not null`),
    check(
      "media_comments_body_check",
      sql.raw(
        `char_length("body") <= ${MEDIA_COMMENT_MAX_LENGTH} and (char_length(btrim("body")) >= 1 or ("deleted_at" is not null and "body" = ''))`
      )
    ),
    check("media_comments_deleted_check", sql`"deleted_by_user_id" is null or "deleted_at" is not null`)
  ]
);

/** A member's report on a comment; one per (comment, reporter). Mirrors `media_reports`. */
export const commentReports = pgTable(
  "comment_reports",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    commentId: uuid("comment_id")
      .notNull()
      .references(() => mediaComments.id, { onDelete: "cascade" }),
    reporterUserId: uuid("reporter_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    reason: text("reason").$type<MediaReportReason>().notNull(),
    details: text("details"),
    createdAt: createdAt()
  },
  (table) => [
    uniqueIndex("comment_reports_comment_reporter_unique").on(table.commentId, table.reporterUserId),
    index("comment_reports_reporter_user_id_idx").on(table.reporterUserId),
    checkIn("comment_reports_reason_check", "reason", MediaReportReason),
    check("comment_reports_details_length_check", sql`"details" is null or char_length("details") <= 500`)
  ]
);
