/**
 * Admin console: users and the audit log. Every admin mutation anywhere in the
 * API writes an audit entry via `recordAudit(tx, …)` in the same transaction.
 */
import { z } from "zod";
import { cursorQuerySchema, dateTimeSchema, idSchema, queryBooleanSchema } from "./common.js";
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
  /** T8: an admin re-enabled a disabled account. */
  UserEnabled: "user.enabled",
  UserSessionsRevoked: "user.sessions_revoked",
  /** T8: an admin forced a password change (sessions revoked, reset email queued). */
  UserPasswordResetForced: "user.password_reset_forced",
  /** T8: an admin marked the account's email as verified by hand. */
  UserEmailVerifiedByAdmin: "user.email_verified_by_admin",
  RefreshReuseDetected: "auth.refresh_reuse_detected",
  /** A used refresh token was presented again inside the grace window (409, nothing revoked). */
  RefreshRace: "auth.refresh_race",
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
  /** T5: a member edited their own profile (metadata: changed field names only). */
  ProfileUpdated: "profile.updated",
  /** T5: a confirmed avatar upload replaced the member's avatar. */
  ProfileAvatarUpdated: "profile.avatar_updated",
  /** T5: the member removed their avatar. */
  ProfileAvatarRemoved: "profile.avatar_removed",
  /** T5: an avatar upload was refused at confirm (`metadata.reason`). */
  ProfileAvatarRejected: "profile.avatar_rejected",
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
  DailyMessageSaved: "daily_message.saved",
  DailyMessageDeleted: "daily_message.deleted",
  ItineraryItemCreated: "itinerary_item.created",
  ItineraryItemUpdated: "itinerary_item.updated",
  ItineraryItemDeleted: "itinerary_item.deleted",
  /** `entityType: cuencada`; the whole edition's itinerary was reordered. */
  ItineraryReordered: "itinerary_item.reordered",
  LocationCreated: "location.created",
  LocationUpdated: "location.updated",
  LocationDeleted: "location.deleted",
  /** `entityType: cuencada`; the whole edition's locations were reordered. */
  LocationsReordered: "location.reordered",
  AnnouncementCreated: "announcement.created",
  AnnouncementUpdated: "announcement.updated",
  AnnouncementDeleted: "announcement.deleted",
  /** `entityType: cuencada`; metadata holds counts only (`added`, `removed`, `total`, `mode`). */
  AttendanceUpdated: "attendance.updated",
  /** `entityType: rsvp`; a member created or changed their own RSVP (metadata: `status`, `guestCount`, `created`). */
  RsvpSaved: "rsvp.saved",
  /** `entityType: cuencada`; an admin downloaded the RSVP CSV (metadata: `rows`). */
  RsvpExported: "rsvp.exported",
  MediaModerated: "media.moderated",
  MediaUploaded: "media.uploaded",
  MediaUploadRejected: "media.upload_rejected",
  MediaUpdated: "media.updated",
  MediaDeleted: "media.deleted",
  MediaReported: "media.reported",
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
  status: userStatusSchema.exactOptional(),
  /** `false`: only accounts whose email is not verified yet (`true`: only verified ones). */
  emailVerified: queryBooleanSchema.exactOptional()
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

/**
 * `POST /api/admin/users/:id/force-password-reset` (T8 amendment). Sets
 * `mustChangePassword`, revokes every session, burns pending email tokens and
 * queues a password-reset email (subject to the email budgets).
 */
export interface AdminForcePasswordResetResult {
  user: AdminUserListItem;
  /** `false` when the account is disabled or an email budget/cap skipped the send. */
  emailQueued: boolean;
}

export const adminForcePasswordResetResultSchema = z.object({
  user: adminUserListItemSchema,
  emailQueued: z.boolean()
}) satisfies z.ZodType<AdminForcePasswordResetResult>;

/* -------------------------------------------------------------------------- */
/* Dashboard summary                                                           */
/* -------------------------------------------------------------------------- */

/** RSVP counts of the next (or current) published edition. */
export interface AdminSummaryEdition {
  cuencadaId: string;
  year: number;
  title: string;
  startsAt: string;
  rsvpYes: number;
  rsvpMaybe: number;
  rsvpNo: number;
  /** Extra guests on `yes` RSVPs. */
  rsvpGuests: number;
}

/** `GET /api/admin/summary` (T8 amendment): dashboard counters, computed in SQL. */
export interface AdminSummary {
  usersActive: number;
  usersDisabled: number;
  /** Active accounts without a verified email. */
  usersUnverified: number;
  activeAdmins: number;
  /** Pending, unexpired invites. */
  invitesPending: number;
  mediaPendingReview: number;
  /** Live media with a report newer than its last moderation. */
  mediaReported: number;
  /** Earliest published edition that has not ended, or `null`. */
  upcomingEdition: AdminSummaryEdition | null;
}

const countSchema = z.number().int().min(0);

export const adminSummaryEditionSchema = z.object({
  cuencadaId: idSchema,
  year: z.number().int(),
  title: z.string().max(200),
  startsAt: dateTimeSchema,
  rsvpYes: countSchema,
  rsvpMaybe: countSchema,
  rsvpNo: countSchema,
  rsvpGuests: countSchema
}) satisfies z.ZodType<AdminSummaryEdition>;

export const adminSummarySchema = z.object({
  usersActive: countSchema,
  usersDisabled: countSchema,
  usersUnverified: countSchema,
  activeAdmins: countSchema,
  invitesPending: countSchema,
  mediaPendingReview: countSchema,
  mediaReported: countSchema,
  upcomingEdition: adminSummaryEditionSchema.nullable()
}) satisfies z.ZodType<AdminSummary>;

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

/**
 * `GET /api/admin/audit-logs` query (newest first).
 *
 * The time range is **half-open**: `from` is inclusive (`created_at >= from`)
 * and `to` is **exclusive** (`created_at < to`). For a "hasta" day filter,
 * send the start of the following day in the portal timezone (i.e.
 * `< hasta + 1 day`), not 23:59:59.999, so rows in the last millisecond
 * (timestamps have microsecond precision) are not lost.
 */
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
