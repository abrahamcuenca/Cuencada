-- Migration 0010 (WP-6.0): photo tags, hearts and comments; notifications;
-- the Memory Box ("Baúl de recuerdos"); tree-link proposals and the family
-- settings row. EXPAND-ONLY, so the code already deployed (0009, WP-5.3)
-- keeps working on this database during the rollout:
--
-- * New tables only receive rows from new code: `media_tags` (pending until
--   a linked person approves, PR #56 L1), `media_likes`, `media_comments`,
--   `comment_reports`, `memory_albums`, `notifications`,
--   `tree_link_proposals` (one pending proposal per proposer and pair, PR #56
--   L2), `family_settings`.
-- * `media_items.memory_album_id` (nullable, ON DELETE RESTRICT). The scope
--   CHECK becomes `num_nonnulls(cuencada_id, album_id, memory_album_id) = 1`
--   and the storage-prefix CHECK also accepts `memories/{uuid}`; both are
--   strictly wider for every row 0009-era code writes (it never sets the new
--   column). A new CHECK pins a box row's prefix to its own box. Dropped and
--   re-added CHECKs and the new FK are added NOT VALID and then validated, in
--   the migration transaction (no window without a CHECK).
-- * 0009-era reads: `mediaScopeSql` lets rows with `album_id is null` through,
--   so the WP-6.0 code also makes it deny any row outside the known scopes
--   (no Memory Box row can exist before WP-6.3 anyway). Rollback floor: once
--   WP-6.3 writes box rows, never roll the code back below WP-6.0.
--
-- Data steps (end of file):
-- 1. The single `family_settings` row (no root yet).
-- 2. Every undismissed WP-5.3 event notice (`event_participants` added by
--    someone else, `notice_seen_at` null) becomes an `event_added`
--    notification for that participant (actor = the adder, dedupe key
--    `event:{eventId}`, time = `joined_at`). `notice_seen_at` stays
--    (deprecated; WP-6.1 keeps the old notice routes as shims). Visibility is
--    not copied: notifications are filtered at read time.
--
-- The runtime role gets the new tables through the default privileges of
-- infra/db/roles.sql.
CREATE TABLE "memory_albums" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"cover_media_id" uuid,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memory_albums_title_length_check" CHECK (char_length("title") between 1 and 120),
	CONSTRAINT "memory_albums_description_length_check" CHECK ("description" is null or char_length("description") <= 2000),
	CONSTRAINT "memory_albums_sort_order_check" CHECK ("sort_order" between 0 and 1000),
	CONSTRAINT "memory_albums_status_check" CHECK ("status" in ('draft', 'published', 'hidden'))
);--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"actor_user_id" uuid,
	"media_id" uuid,
	"event_id" uuid,
	"proposal_id" uuid,
	"dedupe_key" text,
	"count" integer DEFAULT 1 NOT NULL,
	"seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notifications_kind_check" CHECK ("kind" in ('photo_tag_request', 'photo_commented', 'photo_liked', 'event_added', 'tree_proposal_resolved')),
	CONSTRAINT "notifications_target_check" CHECK (("kind" in ('photo_tag_request', 'photo_commented', 'photo_liked') and "media_id" is not null and "event_id" is null and "proposal_id" is null) or ("kind" = 'event_added' and "event_id" is not null and "media_id" is null and "proposal_id" is null) or ("kind" = 'tree_proposal_resolved' and "proposal_id" is not null and "media_id" is null and "event_id" is null)),
	CONSTRAINT "notifications_not_self_check" CHECK ("actor_user_id" is null or "actor_user_id" <> "user_id"),
	CONSTRAINT "notifications_count_check" CHECK ("count" >= 1),
	CONSTRAINT "notifications_dedupe_key_check" CHECK ("dedupe_key" is null or char_length("dedupe_key") between 1 and 200)
);--> statement-breakpoint
CREATE TABLE "family_settings" (
	"id" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"root_person_id" uuid,
	"updated_by_user_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "family_settings_single_row_check" CHECK ("id")
);--> statement-breakpoint
CREATE TABLE "tree_link_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"from_person_id" uuid,
	"to_person_id" uuid,
	"relation" text,
	"note" text,
	"proposed_by_user_id" uuid,
	"status" text DEFAULT 'pending' NOT NULL,
	"resolved_by_user_id" uuid,
	"resolved_at" timestamp with time zone,
	"resolution_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tree_link_proposals_kind_check" CHECK ("kind" in ('same_person', 'relate')),
	CONSTRAINT "tree_link_proposals_status_check" CHECK ("status" in ('pending', 'approved', 'rejected', 'withdrawn')),
	CONSTRAINT "tree_link_proposals_relation_check" CHECK (("kind" = 'relate') = ("relation" is not null) and ("relation" is null or "relation" in ('parent_of', 'partner_of'))),
	CONSTRAINT "tree_link_proposals_distinct_check" CHECK ("from_person_id" <> "to_person_id"),
	CONSTRAINT "tree_link_proposals_pending_people_check" CHECK ("status" <> 'pending' or ("from_person_id" is not null and "to_person_id" is not null)),
	CONSTRAINT "tree_link_proposals_resolved_check" CHECK (("status" = 'pending') = ("resolved_at" is null)),
	CONSTRAINT "tree_link_proposals_note_length_check" CHECK ("note" is null or char_length("note") <= 500),
	CONSTRAINT "tree_link_proposals_resolution_note_length_check" CHECK ("resolution_note" is null or char_length("resolution_note") <= 500)
);--> statement-breakpoint
CREATE TABLE "comment_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"comment_id" uuid NOT NULL,
	"reporter_user_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"details" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "comment_reports_reason_check" CHECK ("reason" in ('inappropriate', 'privacy', 'duplicate', 'other')),
	CONSTRAINT "comment_reports_details_length_check" CHECK ("details" is null or char_length("details") <= 500)
);--> statement-breakpoint
CREATE TABLE "media_comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"media_id" uuid NOT NULL,
	"author_user_id" uuid,
	"body" text NOT NULL,
	"client_comment_id" uuid,
	"deleted_at" timestamp with time zone,
	"deleted_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "media_comments_body_check" CHECK (char_length("body") <= 1000 and (char_length(btrim("body")) >= 1 or ("deleted_at" is not null and "body" = ''))),
	CONSTRAINT "media_comments_deleted_check" CHECK ("deleted_by_user_id" is null or "deleted_at" is not null)
);--> statement-breakpoint
CREATE TABLE "media_likes" (
	"media_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "media_likes_pkey" PRIMARY KEY("media_id","user_id")
);--> statement-breakpoint
CREATE TABLE "media_tags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"media_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"tagged_by_user_id" uuid,
	"status" text DEFAULT 'pending' NOT NULL,
	"approved_at" timestamp with time zone,
	"x" numeric(5, 4),
	"y" numeric(5, 4),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "media_tags_status_check" CHECK ("status" in ('pending', 'approved')),
	CONSTRAINT "media_tags_approved_check" CHECK (("status" = 'approved') = ("approved_at" is not null)),
	CONSTRAINT "media_tags_position_check" CHECK (("x" is null) = ("y" is null) and ("x" is null or ("x" between 0 and 1 and "y" between 0 and 1)))
);--> statement-breakpoint
ALTER TABLE "memory_albums" ADD CONSTRAINT "memory_albums_cover_media_id_media_items_id_fk" FOREIGN KEY ("cover_media_id") REFERENCES "public"."media_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_albums" ADD CONSTRAINT "memory_albums_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_media_id_media_items_id_fk" FOREIGN KEY ("media_id") REFERENCES "public"."media_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_proposal_id_tree_link_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."tree_link_proposals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "family_settings" ADD CONSTRAINT "family_settings_root_person_id_people_id_fk" FOREIGN KEY ("root_person_id") REFERENCES "public"."people"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "family_settings" ADD CONSTRAINT "family_settings_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tree_link_proposals" ADD CONSTRAINT "tree_link_proposals_from_person_id_people_id_fk" FOREIGN KEY ("from_person_id") REFERENCES "public"."people"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tree_link_proposals" ADD CONSTRAINT "tree_link_proposals_to_person_id_people_id_fk" FOREIGN KEY ("to_person_id") REFERENCES "public"."people"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tree_link_proposals" ADD CONSTRAINT "tree_link_proposals_proposed_by_user_id_users_id_fk" FOREIGN KEY ("proposed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tree_link_proposals" ADD CONSTRAINT "tree_link_proposals_resolved_by_user_id_users_id_fk" FOREIGN KEY ("resolved_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comment_reports" ADD CONSTRAINT "comment_reports_comment_id_media_comments_id_fk" FOREIGN KEY ("comment_id") REFERENCES "public"."media_comments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comment_reports" ADD CONSTRAINT "comment_reports_reporter_user_id_users_id_fk" FOREIGN KEY ("reporter_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_comments" ADD CONSTRAINT "media_comments_media_id_media_items_id_fk" FOREIGN KEY ("media_id") REFERENCES "public"."media_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_comments" ADD CONSTRAINT "media_comments_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_comments" ADD CONSTRAINT "media_comments_deleted_by_user_id_users_id_fk" FOREIGN KEY ("deleted_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_likes" ADD CONSTRAINT "media_likes_media_id_media_items_id_fk" FOREIGN KEY ("media_id") REFERENCES "public"."media_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_likes" ADD CONSTRAINT "media_likes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_tags" ADD CONSTRAINT "media_tags_media_id_media_items_id_fk" FOREIGN KEY ("media_id") REFERENCES "public"."media_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_tags" ADD CONSTRAINT "media_tags_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_tags" ADD CONSTRAINT "media_tags_tagged_by_user_id_users_id_fk" FOREIGN KEY ("tagged_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "memory_albums_status_sort_idx" ON "memory_albums" USING btree ("status","sort_order","created_at");--> statement-breakpoint
CREATE INDEX "memory_albums_cover_media_id_idx" ON "memory_albums" USING btree ("cover_media_id");--> statement-breakpoint
CREATE INDEX "memory_albums_created_by_user_id_idx" ON "memory_albums" USING btree ("created_by_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_user_dedupe_unique" ON "notifications" USING btree ("user_id","dedupe_key") WHERE dedupe_key is not null;--> statement-breakpoint
CREATE INDEX "notifications_user_feed_idx" ON "notifications" USING btree ("user_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "notifications_user_unseen_idx" ON "notifications" USING btree ("user_id","created_at" DESC NULLS LAST) WHERE seen_at is null;--> statement-breakpoint
CREATE INDEX "notifications_created_at_idx" ON "notifications" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "notifications_actor_user_id_idx" ON "notifications" USING btree ("actor_user_id");--> statement-breakpoint
CREATE INDEX "notifications_media_id_idx" ON "notifications" USING btree ("media_id");--> statement-breakpoint
CREATE INDEX "notifications_event_id_idx" ON "notifications" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "notifications_proposal_id_idx" ON "notifications" USING btree ("proposal_id");--> statement-breakpoint
CREATE INDEX "family_settings_root_person_id_idx" ON "family_settings" USING btree ("root_person_id");--> statement-breakpoint
CREATE INDEX "family_settings_updated_by_user_id_idx" ON "family_settings" USING btree ("updated_by_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tree_link_proposals_pending_pair_unique" ON "tree_link_proposals" USING btree ("proposed_by_user_id",least("from_person_id", "to_person_id"),greatest("from_person_id", "to_person_id")) WHERE status = 'pending';--> statement-breakpoint
CREATE INDEX "tree_link_proposals_pair_idx" ON "tree_link_proposals" USING btree (least("from_person_id", "to_person_id"),greatest("from_person_id", "to_person_id"),"status");--> statement-breakpoint
CREATE INDEX "tree_link_proposals_status_created_idx" ON "tree_link_proposals" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "tree_link_proposals_proposed_by_idx" ON "tree_link_proposals" USING btree ("proposed_by_user_id","created_at");--> statement-breakpoint
CREATE INDEX "tree_link_proposals_from_person_id_idx" ON "tree_link_proposals" USING btree ("from_person_id");--> statement-breakpoint
CREATE INDEX "tree_link_proposals_to_person_id_idx" ON "tree_link_proposals" USING btree ("to_person_id");--> statement-breakpoint
CREATE INDEX "tree_link_proposals_resolved_by_user_id_idx" ON "tree_link_proposals" USING btree ("resolved_by_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "comment_reports_comment_reporter_unique" ON "comment_reports" USING btree ("comment_id","reporter_user_id");--> statement-breakpoint
CREATE INDEX "comment_reports_reporter_user_id_idx" ON "comment_reports" USING btree ("reporter_user_id");--> statement-breakpoint
CREATE INDEX "media_comments_media_keyset_idx" ON "media_comments" USING btree ("media_id","created_at","id");--> statement-breakpoint
CREATE INDEX "media_comments_author_user_id_idx" ON "media_comments" USING btree ("author_user_id");--> statement-breakpoint
CREATE INDEX "media_comments_deleted_by_user_id_idx" ON "media_comments" USING btree ("deleted_by_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "media_comments_author_client_id_unique" ON "media_comments" USING btree ("author_user_id","client_comment_id") WHERE client_comment_id is not null;--> statement-breakpoint
CREATE INDEX "media_likes_user_id_idx" ON "media_likes" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "media_tags_media_person_unique" ON "media_tags" USING btree ("media_id","person_id");--> statement-breakpoint
CREATE INDEX "media_tags_person_id_idx" ON "media_tags" USING btree ("person_id","status");--> statement-breakpoint
CREATE INDEX "media_tags_tagged_by_user_id_idx" ON "media_tags" USING btree ("tagged_by_user_id");--> statement-breakpoint
-- media_items: the Memory Box scope.
ALTER TABLE "media_items" ADD COLUMN "memory_album_id" uuid;--> statement-breakpoint
ALTER TABLE "media_items" ADD CONSTRAINT "media_items_memory_album_id_memory_albums_id_fk" FOREIGN KEY ("memory_album_id") REFERENCES "public"."memory_albums"("id") ON DELETE restrict ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "media_items" VALIDATE CONSTRAINT "media_items_memory_album_id_memory_albums_id_fk";--> statement-breakpoint
ALTER TABLE "media_items" DROP CONSTRAINT "media_items_scope_check";--> statement-breakpoint
ALTER TABLE "media_items" ADD CONSTRAINT "media_items_scope_check" CHECK (num_nonnulls("cuencada_id", "album_id", "memory_album_id") = 1) NOT VALID;--> statement-breakpoint
ALTER TABLE "media_items" VALIDATE CONSTRAINT "media_items_scope_check";--> statement-breakpoint
ALTER TABLE "media_items" DROP CONSTRAINT "media_items_storage_prefix_check";--> statement-breakpoint
ALTER TABLE "media_items" ADD CONSTRAINT "media_items_storage_prefix_check" CHECK ((("album_id" is null and "memory_album_id" is null) or "storage_prefix" is not null) and ("storage_prefix" is null or "storage_prefix" ~ '^(cuencadas/[0-9]{4}|events/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|memories/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$')) NOT VALID;--> statement-breakpoint
ALTER TABLE "media_items" VALIDATE CONSTRAINT "media_items_storage_prefix_check";--> statement-breakpoint
ALTER TABLE "media_items" ADD CONSTRAINT "media_items_memory_prefix_check" CHECK ("memory_album_id" is null or "storage_prefix" = ('memories/' || "memory_album_id"::text)) NOT VALID;--> statement-breakpoint
ALTER TABLE "media_items" VALIDATE CONSTRAINT "media_items_memory_prefix_check";--> statement-breakpoint
CREATE INDEX "media_items_memory_keyset_idx" ON "media_items" USING btree ("memory_album_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST) WHERE memory_album_id is not null;--> statement-breakpoint
-- Data step 1: the single family_settings row.
INSERT INTO "family_settings" ("id") VALUES (true) ON CONFLICT DO NOTHING;--> statement-breakpoint
-- Data step 2: undismissed WP-5.3 event notices become event_added notifications.
INSERT INTO "notifications" ("user_id", "kind", "actor_user_id", "event_id", "dedupe_key", "count", "created_at", "updated_at")
SELECT p."user_id", 'event_added', p."added_by_user_id", p."event_id", 'event:' || p."event_id"::text, 1, p."joined_at", p."joined_at"
FROM "event_participants" p
WHERE p."added_by_user_id" IS NOT NULL
  AND p."added_by_user_id" <> p."user_id"
  AND p."notice_seen_at" IS NULL
ON CONFLICT DO NOTHING;
