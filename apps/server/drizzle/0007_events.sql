-- Migration events (WP-5.2): Eventos. EXPAND-ONLY, so the code already
-- deployed keeps working on this database during the rollout.
--
-- NUMBERING: planned as 0008. Generated as 0007 on a base without WP-5.1; once
-- WP-5.1's `0007_historical_cuencadas` lands this becomes `0008_events` (rename
-- the file and the journal tag, regenerate the snapshot on top of 5.1's).
-- Every statement touches only the objects named here, so it is mechanical.
--
-- 1. New tables `events`, `event_participants`, `event_albums`,
--    `event_cover_uploads`.
-- 2. `chat_rooms`: nullable `event_id` (FK events ON DELETE CASCADE), the
--    `event` kind, and the kind <-> column CHECK widened so each kind sets
--    exactly its own column (the constraint keeps its 0001 name
--    `chat_rooms_kind_cuencada_check`). Both CHECKs only WIDEN what existing
--    rows and old code use (every room has `event_id` null); they are re-added
--    NOT VALID and validated in this same transaction, so there is no window
--    without a CHECK. Partial unique index: one room per event.
-- 3. `media_items`: `cuencada_id` becomes nullable; new `album_id` (FK
--    event_albums ON DELETE RESTRICT: media rows, soft-deleted ones included,
--    must be deleted before their album or event) and `storage_prefix`
--    (server-generated key prefix; null on legacy rows, which keep
--    `cuencadas/{year}`; required for album rows). `media_items_scope_check`:
--    exactly one of `cuencada_id`/`album_id`. Old code always sets
--    `cuencada_id` and never `album_id`, so it satisfies the new CHECKs, and
--    its reads inner-join `cuencadas`, so album rows (none before WP-5.3)
--    never reach it.
--
-- No data step. Constraints on existing tables: NOT VALID, then VALIDATE
-- (small tables), like 0002/0003/0006.
CREATE TABLE "event_albums" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"title" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "event_albums_title_length_check" CHECK (char_length("title") between 1 and 80),
	CONSTRAINT "event_albums_sort_order_check" CHECK ("sort_order" between 0 and 1000)
);--> statement-breakpoint
CREATE TABLE "event_cover_uploads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"uploaded_by_user_id" uuid,
	"object_key" text NOT NULL,
	"mime_type" text NOT NULL,
	"byte_size" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"confirmed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "event_cover_uploads_mime_type_check" CHECK ("mime_type" in ('image/jpeg', 'image/png', 'image/webp')),
	CONSTRAINT "event_cover_uploads_byte_size_check" CHECK ("byte_size" > 0 and "byte_size" <= 10485760)
);--> statement-breakpoint
CREATE TABLE "event_participants" (
	"event_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text DEFAULT 'participant' NOT NULL,
	"added_by_user_id" uuid,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "event_participants_pkey" PRIMARY KEY("event_id","user_id"),
	CONSTRAINT "event_participants_role_check" CHECK ("role" in ('organizer', 'participant'))
);--> statement-breakpoint
CREATE TABLE "events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"year" integer NOT NULL,
	"title" text NOT NULL,
	"summary" text,
	"details" text,
	"starts_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"timezone" text DEFAULT 'America/Merida' NOT NULL,
	"location_text" text,
	"cover_key" text,
	"cover_updated_at" timestamp with time zone,
	"visibility" text DEFAULT 'members' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"first_published_at" timestamp with time zone,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "events_slug_check" CHECK (char_length("slug") between 3 and 60 and "slug" ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
	CONSTRAINT "events_year_range_check" CHECK ("year" between 1900 and 2200),
	CONSTRAINT "events_dates_check" CHECK (("starts_at" is null and "ends_at" is null) or ("starts_at" is not null and "ends_at" is not null and "ends_at" > "starts_at")),
	CONSTRAINT "events_year_check" CHECK ("starts_at" is null or "year" = extract(year from ("starts_at" at time zone "timezone"))::integer),
	CONSTRAINT "events_title_length_check" CHECK (char_length("title") between 1 and 120),
	CONSTRAINT "events_summary_length_check" CHECK ("summary" is null or char_length("summary") <= 280),
	CONSTRAINT "events_details_length_check" CHECK ("details" is null or char_length("details") <= 4000),
	CONSTRAINT "events_location_text_length_check" CHECK ("location_text" is null or char_length("location_text") <= 160),
	CONSTRAINT "events_cover_check" CHECK (("cover_key" is null) = ("cover_updated_at" is null) and ("cover_key" is null or "cover_key" ~ ('^events/' || "id"::text || '/cover/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-1280[.]webp$'))),
	CONSTRAINT "events_visibility_check" CHECK ("visibility" in ('members', 'participants')),
	CONSTRAINT "events_status_check" CHECK ("status" in ('draft', 'published', 'hidden')),
	CONSTRAINT "events_published_check" CHECK ("status" <> 'published' or "first_published_at" is not null)
);--> statement-breakpoint
ALTER TABLE "event_albums" ADD CONSTRAINT "event_albums_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_albums" ADD CONSTRAINT "event_albums_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_cover_uploads" ADD CONSTRAINT "event_cover_uploads_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_cover_uploads" ADD CONSTRAINT "event_cover_uploads_uploaded_by_user_id_users_id_fk" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_participants" ADD CONSTRAINT "event_participants_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_participants" ADD CONSTRAINT "event_participants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_participants" ADD CONSTRAINT "event_participants_added_by_user_id_users_id_fk" FOREIGN KEY ("added_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "event_albums_event_id_idx" ON "event_albums" USING btree ("event_id","sort_order");--> statement-breakpoint
CREATE INDEX "event_albums_created_by_user_id_idx" ON "event_albums" USING btree ("created_by_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "event_cover_uploads_object_key_unique" ON "event_cover_uploads" USING btree ("object_key");--> statement-breakpoint
CREATE INDEX "event_cover_uploads_event_id_idx" ON "event_cover_uploads" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "event_cover_uploads_uploaded_by_user_id_idx" ON "event_cover_uploads" USING btree ("uploaded_by_user_id");--> statement-breakpoint
CREATE INDEX "event_participants_user_id_idx" ON "event_participants" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "event_participants_added_by_user_id_idx" ON "event_participants" USING btree ("added_by_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "events_year_slug_unique" ON "events" USING btree ("year","slug");--> statement-breakpoint
CREATE INDEX "events_year_starts_at_idx" ON "events" USING btree ("year","starts_at","id");--> statement-breakpoint
CREATE INDEX "events_created_by_user_id_idx" ON "events" USING btree ("created_by_user_id");--> statement-breakpoint
-- chat_rooms: event rooms.
ALTER TABLE "chat_rooms" ADD COLUMN "event_id" uuid;--> statement-breakpoint
ALTER TABLE "chat_rooms" DROP CONSTRAINT "chat_rooms_kind_check";--> statement-breakpoint
ALTER TABLE "chat_rooms" DROP CONSTRAINT "chat_rooms_kind_cuencada_check";--> statement-breakpoint
ALTER TABLE "chat_rooms" ADD CONSTRAINT "chat_rooms_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "chat_rooms" VALIDATE CONSTRAINT "chat_rooms_event_id_events_id_fk";--> statement-breakpoint
ALTER TABLE "chat_rooms" ADD CONSTRAINT "chat_rooms_kind_check" CHECK ("kind" in ('global', 'cuencada', 'event')) NOT VALID;--> statement-breakpoint
ALTER TABLE "chat_rooms" VALIDATE CONSTRAINT "chat_rooms_kind_check";--> statement-breakpoint
ALTER TABLE "chat_rooms" ADD CONSTRAINT "chat_rooms_kind_cuencada_check" CHECK (("kind" = 'global' and "cuencada_id" is null and "event_id" is null) or ("kind" = 'cuencada' and "cuencada_id" is not null and "event_id" is null) or ("kind" = 'event' and "event_id" is not null and "cuencada_id" is null)) NOT VALID;--> statement-breakpoint
ALTER TABLE "chat_rooms" VALIDATE CONSTRAINT "chat_rooms_kind_cuencada_check";--> statement-breakpoint
CREATE UNIQUE INDEX "chat_rooms_event_unique" ON "chat_rooms" USING btree ("event_id") WHERE kind = 'event';--> statement-breakpoint
-- media_items: event-album scope.
ALTER TABLE "media_items" ALTER COLUMN "cuencada_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "media_items" ADD COLUMN "album_id" uuid;--> statement-breakpoint
ALTER TABLE "media_items" ADD COLUMN "storage_prefix" text;--> statement-breakpoint
ALTER TABLE "media_items" ADD CONSTRAINT "media_items_album_id_event_albums_id_fk" FOREIGN KEY ("album_id") REFERENCES "public"."event_albums"("id") ON DELETE restrict ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "media_items" VALIDATE CONSTRAINT "media_items_album_id_event_albums_id_fk";--> statement-breakpoint
ALTER TABLE "media_items" ADD CONSTRAINT "media_items_scope_check" CHECK (num_nonnulls("cuencada_id", "album_id") = 1) NOT VALID;--> statement-breakpoint
ALTER TABLE "media_items" VALIDATE CONSTRAINT "media_items_scope_check";--> statement-breakpoint
ALTER TABLE "media_items" ADD CONSTRAINT "media_items_storage_prefix_check" CHECK (("album_id" is null or "storage_prefix" is not null) and ("storage_prefix" is null or "storage_prefix" ~ '^(cuencadas/[0-9]{4}|events/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$')) NOT VALID;--> statement-breakpoint
ALTER TABLE "media_items" VALIDATE CONSTRAINT "media_items_storage_prefix_check";--> statement-breakpoint
CREATE INDEX "media_items_album_keyset_idx" ON "media_items" USING btree ("album_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST) WHERE album_id is not null;
