/**
 * Accounts and credentials: users, sessions, rotating refresh tokens, invites
 * and magic links. Every token is stored as a SHA-256 hash, never plaintext.
 */
import { InviteStatus, UserRole, UserStatus } from "@cuencada/types";
import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  uniqueIndex,
  uuid
} from "drizzle-orm/pg-core";
import { checkIn, createdAt, timestamptz, updatedAt } from "./helpers.js";
import { people } from "./people.js";

/** What a magic-link row is for. One table serves all single-use email tokens. */
export const MagicLinkPurpose = {
  Login: "login",
  PasswordReset: "password_reset",
  EmailVerify: "email_verify"
} as const;
export type MagicLinkPurpose = (typeof MagicLinkPurpose)[keyof typeof MagicLinkPurpose];

/** Why a session was revoked (`sessions.revoked_reason`). */
export const SessionRevokedReason = {
  Logout: "logout",
  UserRevoked: "user_revoked",
  RevokeOthers: "revoke_others",
  PasswordChanged: "password_changed",
  PasswordReset: "password_reset",
  UserDisabled: "user_disabled",
  AdminRevoked: "admin_revoked",
  RefreshReuse: "refresh_reuse"
} as const;
export type SessionRevokedReason = (typeof SessionRevokedReason)[keyof typeof SessionRevokedReason];

export const users = pgTable(
  "users",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    /** Stored lowercased by the app; uniqueness is on `lower(email)`. */
    email: text("email").notNull(),
    passwordHash: text("password_hash"),
    displayName: text("display_name").notNull(),
    role: text("role").$type<UserRole>().notNull().default("member"),
    status: text("status").$type<UserStatus>().notNull().default("active"),
    mustChangePassword: boolean("must_change_password").notNull().default(false),
    emailVerifiedAt: timestamptz("email_verified_at"),
    passwordChangedAt: timestamptz("password_changed_at"),
    invitedByInviteId: uuid("invited_by_invite_id").references((): AnyPgColumn => invites.id, {
      onDelete: "set null"
    }),
    lastLoginAt: timestamptz("last_login_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  },
  (table) => [
    uniqueIndex("users_email_lower_unique").on(sql`lower(${table.email})`),
    index("users_invited_by_invite_id_idx").on(table.invitedByInviteId),
    checkIn("users_role_check", "role", UserRole),
    checkIn("users_status_check", "status", UserStatus)
  ]
);

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    userAgent: text("user_agent"),
    ipAddress: text("ip_address"),
    lastUsedAt: timestamptz("last_used_at").notNull().defaultNow(),
    /** Sliding expiry, pushed forward on each refresh. */
    idleExpiresAt: timestamptz("idle_expires_at").notNull(),
    /** Hard cap; a session never outlives this. */
    absoluteExpiresAt: timestamptz("absolute_expires_at").notNull(),
    revokedAt: timestamptz("revoked_at"),
    revokedReason: text("revoked_reason").$type<SessionRevokedReason>(),
    createdAt: createdAt()
  },
  (table) => [
    index("sessions_user_id_idx").on(table.userId),
    checkIn("sessions_revoked_reason_check", "revoked_reason", SessionRevokedReason),
    check("sessions_revoked_consistent_check", sql`("revoked_at" is null) = ("revoked_reason" is null)`),
    check("sessions_idle_before_absolute_check", sql`"idle_expires_at" <= "absolute_expires_at"`)
  ]
);

/**
 * One row per issued refresh token. Rotation marks the old row `used_at` and
 * links `replaced_by_token_id`; presenting a used token after the grace window
 * is reuse and revokes the whole session.
 */
export const refreshTokens = pgTable(
  "refresh_tokens",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamptz("expires_at").notNull(),
    usedAt: timestamptz("used_at"),
    replacedByTokenId: uuid("replaced_by_token_id").references((): AnyPgColumn => refreshTokens.id, {
      onDelete: "set null"
    }),
    createdAt: createdAt()
  },
  (table) => [
    uniqueIndex("refresh_tokens_token_hash_unique").on(table.tokenHash),
    index("refresh_tokens_session_id_idx").on(table.sessionId),
    index("refresh_tokens_replaced_by_token_id_idx").on(table.replacedByTokenId)
  ]
);

export const invites = pgTable(
  "invites",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tokenHash: text("token_hash").notNull(),
    /** Bound email (lowercased) or `null` for an open, member-only invite. */
    email: text("email"),
    /** Suggested display name shown on the accept screen. */
    displayName: text("display_name"),
    role: text("role").$type<UserRole>().notNull().default("member"),
    maxUses: integer("max_uses").notNull().default(1),
    useCount: integer("use_count").notNull().default(0),
    status: text("status").$type<InviteStatus>().notNull().default("pending"),
    /** Tree node the new account is linked to on acceptance. */
    personId: uuid("person_id").references((): AnyPgColumn => people.id, { onDelete: "set null" }),
    note: text("note"),
    expiresAt: timestamptz("expires_at").notNull(),
    acceptedAt: timestamptz("accepted_at"),
    revokedAt: timestamptz("revoked_at"),
    lastSentAt: timestamptz("last_sent_at"),
    createdByUserId: uuid("created_by_user_id").references((): AnyPgColumn => users.id, {
      onDelete: "set null"
    }),
    createdAt: createdAt()
  },
  (table) => [
    uniqueIndex("invites_token_hash_unique").on(table.tokenHash),
    index("invites_created_by_user_id_idx").on(table.createdByUserId),
    index("invites_person_id_idx").on(table.personId),
    index("invites_status_created_at_idx").on(table.status, table.createdAt),
    checkIn("invites_role_check", "role", UserRole),
    checkIn("invites_status_check", "status", InviteStatus),
    check("invites_uses_check", sql`"max_uses" >= 1 and "use_count" >= 0 and "use_count" <= "max_uses"`),
    // Admin invites must be bound to an email and single-use (contract rule, enforced twice).
    check("invites_admin_bound_check", sql`"role" <> 'admin' or ("email" is not null and "max_uses" = 1)`),
    // Open (email-less) invites are capped at 20 uses (contract rule; the 14-day cap is service-level).
    check("invites_open_max_uses_check", sql`"email" is not null or "max_uses" <= 20`)
  ]
);

export const magicLinks = pgTable(
  "magic_links",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    email: text("email").notNull(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    purpose: text("purpose").$type<MagicLinkPurpose>().notNull().default("login"),
    requestIp: text("request_ip"),
    expiresAt: timestamptz("expires_at").notNull(),
    usedAt: timestamptz("used_at"),
    createdAt: createdAt()
  },
  (table) => [
    uniqueIndex("magic_links_token_hash_unique").on(table.tokenHash),
    index("magic_links_user_id_idx").on(table.userId),
    index("magic_links_email_created_at_idx").on(table.email, table.createdAt),
    checkIn("magic_links_purpose_check", "purpose", MagicLinkPurpose)
  ]
);
