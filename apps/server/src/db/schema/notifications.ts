/**
 * In-app notifications (WP-6.0, migration 0010; WP-6.1 implements): the bell
 * and the `/notificaciones` feed. Each row targets exactly the entity its
 * `kind` needs (`notifications_target_check`); targets are re-checked for
 * visibility at read time (ADR 0001 §8). Rows coalesce per
 * `(user_id, dedupe_key)`: a repeated like/comment on the same photo updates
 * the row (`count`, `actor_user_id`, `created_at`, `seen_at = null`).
 * Retention: 180 days (cleanup job) and at most 500 rows per recipient
 * (`NOTIFICATIONS_PER_USER_MAX`, trimmed on write), WP-6.1.
 */
import { NOTIFICATION_DEDUPE_KEY_MAX_LENGTH, NotificationKind } from "@cuencada/types";
import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { users } from "./auth.js";
import { events } from "./events.js";
import { checkIn, createdAt, timestamptz, updatedAt } from "./helpers.js";
import { mediaItems } from "./media.js";
import { treeLinkProposals } from "./people.js";

export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    /** The recipient. */
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind").$type<NotificationKind>().notNull(),
    /** The (latest) member who caused it; never the recipient (CHECK). */
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    mediaId: uuid("media_id").references(() => mediaItems.id, { onDelete: "cascade" }),
    eventId: uuid("event_id").references(() => events.id, { onDelete: "cascade" }),
    proposalId: uuid("proposal_id").references(() => treeLinkProposals.id, { onDelete: "cascade" }),
    /** Server-built coalescing key (`notificationDedupeKey`), unique per recipient. */
    dedupeKey: text("dedupe_key"),
    /** Events coalesced into this row. */
    count: integer("count").notNull().default(1),
    seenAt: timestamptz("seen_at"),
    /** When it last fired (coalescing moves it); the feed order. */
    createdAt: createdAt(),
    updatedAt: updatedAt()
  },
  (table) => [
    uniqueIndex("notifications_user_dedupe_unique")
      .on(table.userId, table.dedupeKey)
      .where(sql`dedupe_key is not null`),
    // Feed keyset: newest first.
    index("notifications_user_feed_idx").on(table.userId, table.createdAt.desc(), table.id.desc()),
    // Unread badge.
    index("notifications_user_unseen_idx")
      .on(table.userId, table.createdAt.desc())
      .where(sql`seen_at is null`),
    // Retention sweep.
    index("notifications_created_at_idx").on(table.createdAt),
    index("notifications_actor_user_id_idx").on(table.actorUserId),
    index("notifications_media_id_idx").on(table.mediaId),
    index("notifications_event_id_idx").on(table.eventId),
    index("notifications_proposal_id_idx").on(table.proposalId),
    checkIn("notifications_kind_check", "kind", NotificationKind),
    check(
      "notifications_target_check",
      sql`("kind" in ('photo_tag_request', 'photo_commented', 'photo_liked') and "media_id" is not null and "event_id" is null and "proposal_id" is null) or ("kind" = 'event_added' and "event_id" is not null and "media_id" is null and "proposal_id" is null) or ("kind" = 'tree_proposal_resolved' and "proposal_id" is not null and "media_id" is null and "event_id" is null)`
    ),
    check("notifications_not_self_check", sql`"actor_user_id" is null or "actor_user_id" <> "user_id"`),
    check("notifications_count_check", sql`"count" >= 1`),
    check(
      "notifications_dedupe_key_check",
      sql.raw(`"dedupe_key" is null or char_length("dedupe_key") between 1 and ${NOTIFICATION_DEDUPE_KEY_MAX_LENGTH}`)
    )
  ]
);
