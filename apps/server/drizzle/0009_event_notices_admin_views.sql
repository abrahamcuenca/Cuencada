-- Migration 0009 (WP-5.3): event consent notices and the admin-view audit
-- dedupe. EXPAND-ONLY, so the code already deployed (0008, WP-5.2) keeps
-- working on this database during the rollout.
--
-- 1. `event_participants.notice_seen_at` (nullable): when a member dismissed
--    the "you were added to an event" notice (Security requirement 3). Old
--    code never reads or writes it.
-- 2. New table `event_admin_views`: one row per (admin, event, hour bucket),
--    the race-free dedupe key of the `event.admin_viewed` audit (Security
--    requirement 5). Only new code writes it.
--
-- No data step; the runtime role gets the table through the default
-- privileges of infra/db/roles.sql.
CREATE TABLE "event_admin_views" (
	"admin_user_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"hour_bucket" timestamp with time zone NOT NULL,
	CONSTRAINT "event_admin_views_pkey" PRIMARY KEY("admin_user_id","event_id","hour_bucket")
);
--> statement-breakpoint
ALTER TABLE "event_participants" ADD COLUMN "notice_seen_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "event_admin_views" ADD CONSTRAINT "event_admin_views_admin_user_id_users_id_fk" FOREIGN KEY ("admin_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_admin_views" ADD CONSTRAINT "event_admin_views_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "event_admin_views_event_id_idx" ON "event_admin_views" USING btree ("event_id");