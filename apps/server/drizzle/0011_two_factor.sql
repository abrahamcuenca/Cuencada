-- Migration 0011 (WP-7): TOTP two-step verification. EXPAND-ONLY, so the
-- code already deployed (0010, WP-6) keeps working on this database during
-- the rollout:
--
-- * New tables only receive rows from new code: `user_totp` (the secret,
--   AES-256-GCM under TOTP_ENCRYPTION_KEY; never in clear), `user_recovery_codes`
--   (SHA-256 hashes), `trusted_devices` (token hashes, members only) and
--   `two_factor_challenges` (token hashes, 5 minutes, 5 attempts).
-- * `sessions.two_factor_verified_at` (nullable, no default): 0010-era code
--   never sets it. Every existing session reads as "not verified", so after
--   the deploy existing administrators hit the enrollment gate on their next
--   request and must enroll (runbook). No data step.
CREATE TABLE "trusted_devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"user_agent_label" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "trusted_devices_label_length_check" CHECK (char_length("trusted_devices"."user_agent_label") <= 80)
);
--> statement-breakpoint
CREATE TABLE "two_factor_challenges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL,
	"user_id" uuid NOT NULL,
	"purpose" text DEFAULT 'login' NOT NULL,
	"method" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"consumed_at" timestamp with time zone,
	CONSTRAINT "two_factor_challenges_purpose_check" CHECK ("purpose" in ('login')),
	CONSTRAINT "two_factor_challenges_method_check" CHECK ("method" in ('password', 'magic_link')),
	CONSTRAINT "two_factor_challenges_attempts_check" CHECK ("two_factor_challenges"."attempts" >= 0 and "two_factor_challenges"."attempts" <= 5)
);
--> statement-breakpoint
CREATE TABLE "user_recovery_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"code_hash" text NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_totp" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"secret_ciphertext" text NOT NULL,
	"secret_iv" text NOT NULL,
	"secret_tag" text NOT NULL,
	"enabled_at" timestamp with time zone,
	"last_used_step" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_totp_last_used_step_check" CHECK ("user_totp"."last_used_step" is null or "user_totp"."last_used_step" >= 0)
);
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "two_factor_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "trusted_devices" ADD CONSTRAINT "trusted_devices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "two_factor_challenges" ADD CONSTRAINT "two_factor_challenges_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_recovery_codes" ADD CONSTRAINT "user_recovery_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_totp" ADD CONSTRAINT "user_totp_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "trusted_devices_token_hash_unique" ON "trusted_devices" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "trusted_devices_user_id_idx" ON "trusted_devices" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "two_factor_challenges_token_hash_unique" ON "two_factor_challenges" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "two_factor_challenges_user_id_idx" ON "two_factor_challenges" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "two_factor_challenges_expires_at_idx" ON "two_factor_challenges" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "user_recovery_codes_user_code_unique" ON "user_recovery_codes" USING btree ("user_id","code_hash");--> statement-breakpoint
CREATE INDEX "user_recovery_codes_user_id_idx" ON "user_recovery_codes" USING btree ("user_id");