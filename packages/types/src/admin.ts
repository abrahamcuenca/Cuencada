/**
 * Admin console: users and the audit log. Every admin mutation anywhere in the
 * API writes an audit entry via `recordAudit(tx, …)` in the same transaction.
 */
import { z } from "zod";
import { cursorQuerySchema, dateTimeSchema, idSchema } from "./common.js";
import { type UserRole, type UserStatus, userRoleSchema, userStatusSchema } from "./auth.js";

/** Entity types that appear in the audit log. */
export const AuditEntityType = {
  User: "user",
  Session: "session",
  Invite: "invite",
  Profile: "profile",
  Cuencada: "cuencada",
  ItineraryItem: "itinerary_item",
  Location: "location",
  Announcement: "announcement",
  DailyMessage: "daily_message",
  Rsvp: "rsvp",
  Attendance: "attendance",
  Media: "media",
  Person: "person",
  Relationship: "relationship",
  ChatMessage: "chat_message"
} as const;
export type AuditEntityType = (typeof AuditEntityType)[keyof typeof AuditEntityType];
export const auditEntityTypeSchema = z.enum(AuditEntityType);

/**
 * Well-known audit actions. Tracks may add more following the same
 * `entity.verb_past` pattern (validated by `auditActionSchema`).
 */
export const AuditAction = {
  UserUpdated: "user.updated",
  UserDisabled: "user.disabled",
  UserSessionsRevoked: "user.sessions_revoked",
  RefreshReuseDetected: "auth.refresh_reuse_detected",
  PasswordChanged: "auth.password_changed",
  PasswordReset: "auth.password_reset",
  /** Password or magic-link login (`metadata.method`). */
  LoggedIn: "auth.logged_in",
  /** Failed login for an existing account (`metadata.reason`: `bad_password` | `inactive`). */
  LoginFailed: "auth.login_failed",
  LoggedOut: "auth.logged_out",
  /** The user revoked one of their own sessions. */
  SessionRevoked: "auth.session_revoked",
  /** The user revoked several sessions (`metadata.scope`: `all` | `others`). */
  SessionsRevoked: "auth.sessions_revoked",
  PasswordResetRequested: "auth.password_reset_requested",
  MagicLinkRequested: "auth.magic_link_requested",
  EmailVerificationRequested: "auth.email_verification_requested",
  EmailVerified: "auth.email_verified",
  InviteCreated: "invite.created",
  InviteRevoked: "invite.revoked",
  /** A new token was issued and emailed. */
  InviteResent: "invite.resent",
  InviteAccepted: "invite.accepted",
  CuencadaCreated: "cuencada.created",
  CuencadaUpdated: "cuencada.updated",
  /** Written (instead of/in addition to `updated`) when `isPublished` flips to true. */
  CuencadaPublished: "cuencada.published",
  CuencadaUnpublished: "cuencada.unpublished",
  CuencadaDeleted: "cuencada.deleted",
  DailyMessagesImported: "daily_message.imported",
  AttendanceUpdated: "attendance.updated",
  MediaModerated: "media.moderated",
  PersonCreated: "person.created",
  PersonUpdated: "person.updated",
  PersonDeleted: "person.deleted",
  RelationshipCreated: "relationship.created",
  RelationshipDeleted: "relationship.deleted",
  ChatMessageDeleted: "chat_message.deleted"
} as const;
export type AuditAction = (typeof AuditAction)[keyof typeof AuditAction];

/** Audit action, dotted lowercase, e.g. `user.disabled`, `cuencada.published`, `media.moderated`. */
export const auditActionSchema = z
  .string()
  .trim()
  .max(100)
  .regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/, { error: "Acción inválida." });

/* -------------------------------------------------------------------------- */
/* Users                                                                       */
/* -------------------------------------------------------------------------- */

/** User row in the admin console. */
export interface AdminUserListItem {
  id: string;
  email: string;
  displayName: string;
  role: UserRole;
  status: UserStatus;
  mustChangePassword: boolean;
  emailVerified: boolean;
  personId: string | null;
  lastLoginAt: string | null;
  activeSessionCount: number;
  createdAt: string;
}

export const adminUserListItemSchema = z.object({
  id: idSchema,
  email: z.string().max(254),
  displayName: z.string().max(80),
  role: userRoleSchema,
  status: userStatusSchema,
  mustChangePassword: z.boolean(),
  emailVerified: z.boolean(),
  personId: idSchema.nullable(),
  lastLoginAt: dateTimeSchema.nullable(),
  activeSessionCount: z.number().int(),
  createdAt: dateTimeSchema
}) satisfies z.ZodType<AdminUserListItem>;

/** `GET /api/admin/users` query. */
export const adminUserListQuerySchema = cursorQuerySchema.extend({
  q: z.string().trim().max(100).exactOptional(),
  role: userRoleSchema.exactOptional(),
  status: userStatusSchema.exactOptional()
});
export type AdminUserListQuery = z.infer<typeof adminUserListQuerySchema>;
export type AdminUserListQueryRequest = z.input<typeof adminUserListQuerySchema>;

/**
 * `PATCH /api/admin/users/:id`. Disabling revokes every session.
 * The server refuses (409 `CONFLICT`) to demote/disable the last active admin
 * and (403) to change the caller's own role or status.
 */
export const adminUserPatchInputSchema = z
  .object({
    role: userRoleSchema,
    status: userStatusSchema,
    /** `true` forces a password change at next request. */
    mustChangePassword: z.literal(true)
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, { error: "No hay cambios que guardar." });
export type AdminUserPatchInput = z.infer<typeof adminUserPatchInputSchema>;
export type AdminUserPatchRequest = z.input<typeof adminUserPatchInputSchema>;

/* -------------------------------------------------------------------------- */
/* Audit log                                                                   */
/* -------------------------------------------------------------------------- */

/** Audit entry. `metadata` never contains secrets, tokens or passwords. */
export interface AuditLogEntry {
  id: string;
  actorUserId: string | null;
  actorName: string | null;
  action: string;
  /** Free string on purpose: older rows may predate `AuditEntityType`. Filter with `auditEntityTypeSchema`. */
  entityType: string;
  entityId: string | null;
  metadata: Record<string, unknown>;
  ip: string | null;
  createdAt: string;
}

export const auditLogEntrySchema = z.object({
  id: idSchema,
  actorUserId: idSchema.nullable(),
  actorName: z.string().max(80).nullable(),
  action: z.string().max(100),
  entityType: z.string().max(50),
  entityId: z.string().max(100).nullable(),
  metadata: z.record(z.string(), z.unknown()),
  ip: z.string().max(64).nullable(),
  createdAt: dateTimeSchema
}) satisfies z.ZodType<AuditLogEntry>;

/** `GET /api/admin/audit-logs` query (newest first). */
export const auditLogQuerySchema = cursorQuerySchema
  .extend({
    actorUserId: idSchema.exactOptional(),
    entityType: auditEntityTypeSchema.exactOptional(),
    entityId: z.string().trim().max(100).exactOptional(),
    action: auditActionSchema.exactOptional(),
    from: z.iso.datetime({ offset: true }).exactOptional(),
    to: z.iso.datetime({ offset: true }).exactOptional()
  })
  .refine((value) => value.from === undefined || value.to === undefined || Date.parse(value.from) <= Date.parse(value.to), {
    error: "El rango de fechas es inválido.",
    path: ["to"]
  });
export type AuditLogQuery = z.infer<typeof auditLogQuerySchema>;
export type AuditLogQueryRequest = z.input<typeof auditLogQuerySchema>;
