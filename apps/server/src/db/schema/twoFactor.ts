/**
 * Two-step verification (WP-7, migration 0011, expand-only) [SEC].
 *
 * - `user_totp`: one row per user. The TOTP secret is encrypted with
 *   AES-256-GCM under `TOTP_ENCRYPTION_KEY` (AAD = the user id), never stored
 *   in clear. `enabled_at` null = a pending secret from setup.
 *   `last_used_step` blocks replay: a step at or below it is refused.
 * - `user_recovery_codes`: SHA-256 hashes of 80-bit single-use codes.
 * - `trusted_devices`: members' "Confiar en este dispositivo 30 días"; only the
 *   SHA-256 hash of the opaque cookie token is stored, with a coarse label.
 * - `two_factor_challenges`: a login that passed the first factor and waits
 *   for a code (5 minutes, 5 attempts); only the token hash is stored.
 */
import { sql } from "drizzle-orm";
import { bigint, check, index, integer, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { users } from "./auth.js";
import { checkIn, createdAt, timestamptz, updatedAt } from "./helpers.js";

/** What a challenge is for (only `login` today). */
export const TwoFactorChallengePurpose = {
  Login: "login"
} as const;
export type TwoFactorChallengePurpose = (typeof TwoFactorChallengePurpose)[keyof typeof TwoFactorChallengePurpose];

/** Which first factor started the pending login (the session's audit `method`). */
export const TwoFactorLoginMethod = {
  Password: "password",
  MagicLink: "magic_link"
} as const;
export type TwoFactorLoginMethod = (typeof TwoFactorLoginMethod)[keyof typeof TwoFactorLoginMethod];

export const userTotp = pgTable(
  "user_totp",
  {
    userId: uuid("user_id")
      .primaryKey()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Base64 AES-256-GCM ciphertext of the base32 secret. */
    secretCiphertext: text("secret_ciphertext").notNull(),
    /** Base64 96-bit nonce, fresh for every encryption. */
    secretIv: text("secret_iv").notNull(),
    /** Base64 128-bit GCM authentication tag. */
    secretTag: text("secret_tag").notNull(),
    /** `null` while pending (setup started, not yet proven by a code). */
    enabledAt: timestamptz("enabled_at"),
    /** Highest TOTP time step accepted so far (replay prevention). */
    lastUsedStep: bigint("last_used_step", { mode: "number" }),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  },
  (table) => [check("user_totp_last_used_step_check", sql`${table.lastUsedStep} is null or ${table.lastUsedStep} >= 0`)]
);

export const userRecoveryCodes = pgTable(
  "user_recovery_codes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** SHA-256 hex of the normalized code. */
    codeHash: text("code_hash").notNull(),
    usedAt: timestamptz("used_at"),
    createdAt: createdAt()
  },
  (table) => [
    uniqueIndex("user_recovery_codes_user_code_unique").on(table.userId, table.codeHash),
    index("user_recovery_codes_user_id_idx").on(table.userId)
  ]
);

export const trustedDevices = pgTable(
  "trusted_devices",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** SHA-256 hex of the opaque cookie token. */
    tokenHash: text("token_hash").notNull(),
    /** Coarse device label ("iPhone · Safari"), never the full User-Agent. */
    userAgentLabel: text("user_agent_label").notNull(),
    createdAt: createdAt(),
    expiresAt: timestamptz("expires_at").notNull(),
    lastUsedAt: timestamptz("last_used_at"),
    revokedAt: timestamptz("revoked_at")
  },
  (table) => [
    uniqueIndex("trusted_devices_token_hash_unique").on(table.tokenHash),
    index("trusted_devices_user_id_idx").on(table.userId),
    check("trusted_devices_label_length_check", sql`char_length(${table.userAgentLabel}) <= 80`)
  ]
);

export const twoFactorChallenges = pgTable(
  "two_factor_challenges",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tokenHash: text("token_hash").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    purpose: text("purpose").$type<TwoFactorChallengePurpose>().notNull().default("login"),
    /** The first factor of the pending login. */
    method: text("method").$type<TwoFactorLoginMethod>().notNull(),
    createdAt: createdAt(),
    expiresAt: timestamptz("expires_at").notNull(),
    attempts: integer("attempts").notNull().default(0),
    /** Set on success, and when the last attempt burns the challenge. */
    consumedAt: timestamptz("consumed_at")
  },
  (table) => [
    uniqueIndex("two_factor_challenges_token_hash_unique").on(table.tokenHash),
    index("two_factor_challenges_user_id_idx").on(table.userId),
    index("two_factor_challenges_expires_at_idx").on(table.expiresAt),
    checkIn("two_factor_challenges_purpose_check", "purpose", TwoFactorChallengePurpose),
    checkIn("two_factor_challenges_method_check", "method", TwoFactorLoginMethod),
    check("two_factor_challenges_attempts_check", sql`${table.attempts} >= 0 and ${table.attempts} <= 5`)
  ]
);
