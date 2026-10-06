/**
 * Auth, sessions and invites.
 *
 * Security rules encoded here:
 * - Every token (invite, magic link, reset, email verification) travels in a
 *   JSON request **body**. Emails put it in the URL *fragment*; the SPA reads
 *   the fragment and POSTs it. Tokens never appear in a path or query string.
 * - The refresh token is never in a JSON body: it lives only in the
 *   `__Secure-cuencada_rt` HttpOnly cookie (Path=/api/auth).
 * - The access token is returned in the body and kept in memory only.
 */
import { z } from "zod";
import {
  dateTimeSchema,
  emailSchema,
  idSchema,
  displayTextSchema,
  nullableTextSchema,
  opaqueTokenSchema,
  cursorQuerySchema
} from "./common.js";

/* -------------------------------------------------------------------------- */
/* Enums                                                                       */
/* -------------------------------------------------------------------------- */

export const UserRole = {
  Admin: "admin",
  Member: "member"
} as const;
export type UserRole = (typeof UserRole)[keyof typeof UserRole];
export const userRoleSchema = z.enum(UserRole);

/** `disabled` users cannot log in and all their sessions are revoked. */
export const UserStatus = {
  Active: "active",
  Disabled: "disabled"
} as const;
export type UserStatus = (typeof UserStatus)[keyof typeof UserStatus];
export const userStatusSchema = z.enum(UserStatus);

export const InviteStatus = {
  Pending: "pending",
  Accepted: "accepted",
  Revoked: "revoked",
  Expired: "expired"
} as const;
export type InviteStatus = (typeof InviteStatus)[keyof typeof InviteStatus];
export const inviteStatusSchema = z.enum(InviteStatus);

/* -------------------------------------------------------------------------- */
/* Passwords                                                                   */
/* -------------------------------------------------------------------------- */

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

/**
 * New-password policy (NIST 800-63B style): 12–128 characters, not only
 * whitespace. No composition rules. Never trimmed: spaces are significant.
 * Breached-password checks, if any, happen server-side.
 */
export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, { error: `La contraseña debe tener al menos ${PASSWORD_MIN_LENGTH} caracteres.` })
  .max(PASSWORD_MAX_LENGTH, { error: `La contraseña puede tener como máximo ${PASSWORD_MAX_LENGTH} caracteres.` })
  .refine((value) => value.trim().length > 0, { error: "La contraseña no puede ser solo espacios." });

/** Password as typed at login: no policy (old passwords may predate it), only bounds. */
export const currentPasswordSchema = z
  .string()
  .min(1, { error: "Escribe tu contraseña." })
  .max(PASSWORD_MAX_LENGTH, { error: "Contraseña inválida." });

/** Display name shown across the portal. */
/** Display name shown across the portal: NFC, no bidi/invisible characters (anti-spoofing). */
export const displayNameSchema = displayTextSchema(80);

/* -------------------------------------------------------------------------- */
/* Current user and token responses                                            */
/* -------------------------------------------------------------------------- */

/** The logged-in user, as returned by `GET /api/me` and every auth response. */
export interface CurrentUser {
  id: string;
  email: string;
  displayName: string;
  role: UserRole;
  status: UserStatus;
  /** When true every route except `/me`, change-password, logout and refresh answers 403 `PASSWORD_CHANGE_REQUIRED`. */
  mustChangePassword: boolean;
  /**
   * True only once the user proved control of the mailbox: by a verify-email
   * token, a magic-link login, a password reset, or accepting an invite that
   * was actually **delivered by email** (`sendEmail: true`). Accepting a
   * copy-link invite leaves it `false`.
   */
  emailVerified: boolean;
  /** Family-tree person linked to this account, if any. */
  personId: string | null;
  /** Presigned avatar URL (1h) or `null`. */
  avatarUrl: string | null;
}

export const currentUserSchema = z.object({
  id: idSchema,
  email: z.string().max(254),
  displayName: z.string().max(80),
  role: userRoleSchema,
  status: userStatusSchema,
  mustChangePassword: z.boolean(),
  emailVerified: z.boolean(),
  personId: idSchema.nullable(),
  avatarUrl: z.string().max(4096).nullable()
}) satisfies z.ZodType<CurrentUser>;

/**
 * Returned by login, refresh, magic-link consume, invite accept and
 * change-password. The refresh token is set as a cookie, never in this body.
 */
export interface AuthTokenResponse {
  accessToken: string;
  /** ISO instant when `accessToken` expires (10–15 min). */
  accessTokenExpiresAt: string;
  user: CurrentUser;
}

export const authTokenResponseSchema = z.object({
  accessToken: z.string().max(4096),
  accessTokenExpiresAt: dateTimeSchema,
  user: currentUserSchema
}) satisfies z.ZodType<AuthTokenResponse>;

/** `POST /api/auth/refresh` response (same shape as login). */
export type RefreshResponse = AuthTokenResponse;
export const refreshResponseSchema = authTokenResponseSchema;

/** Name of the CSRF header required on cookie-authenticated routes (refresh, logout). */
export const CSRF_HEADER = "x-cuencada-csrf";
/** Name of the refresh-token cookie. */
export const REFRESH_COOKIE = "__Secure-cuencada_rt";

/* -------------------------------------------------------------------------- */
/* Inputs                                                                      */
/* -------------------------------------------------------------------------- */

export const loginInputSchema = z.object({
  email: emailSchema,
  password: currentPasswordSchema
});
export type LoginInput = z.infer<typeof loginInputSchema>;
export type LoginRequest = z.input<typeof loginInputSchema>;

export const changePasswordInputSchema = z
  .object({
    currentPassword: currentPasswordSchema,
    newPassword: passwordSchema
  })
  .refine((value) => value.currentPassword !== value.newPassword, {
    error: "La nueva contraseña debe ser distinta de la actual.",
    path: ["newPassword"]
  });
export type ChangePasswordInput = z.infer<typeof changePasswordInputSchema>;
export type ChangePasswordRequest = z.input<typeof changePasswordInputSchema>;

/** Always answered with a generic 202 `OkResponse`, whether or not the email exists. */
export const magicLinkRequestInputSchema = z.object({ email: emailSchema });
export type MagicLinkRequestInput = z.infer<typeof magicLinkRequestInputSchema>;
export type MagicLinkRequestRequest = z.input<typeof magicLinkRequestInputSchema>;

/** Token read by the SPA from the URL fragment `#t=…`. */
export const magicLinkConsumeInputSchema = z.object({ token: opaqueTokenSchema });
export type MagicLinkConsumeInput = z.infer<typeof magicLinkConsumeInputSchema>;
export type MagicLinkConsumeRequest = z.input<typeof magicLinkConsumeInputSchema>;

/** Always answered with a generic 202 `OkResponse`, whether or not the email exists. */
export const passwordResetRequestInputSchema = z.object({ email: emailSchema });
export type PasswordResetRequestInput = z.infer<typeof passwordResetRequestInputSchema>;
export type PasswordResetRequestRequest = z.input<typeof passwordResetRequestInputSchema>;

/** Confirms a reset. Revokes every existing session of the user. */
export const passwordResetConfirmInputSchema = z.object({
  token: opaqueTokenSchema,
  newPassword: passwordSchema
});
export type PasswordResetConfirmInput = z.infer<typeof passwordResetConfirmInputSchema>;
export type PasswordResetConfirmRequest = z.input<typeof passwordResetConfirmInputSchema>;

export const emailVerifyConfirmInputSchema = z.object({ token: opaqueTokenSchema });
export type EmailVerifyConfirmInput = z.infer<typeof emailVerifyConfirmInputSchema>;
export type EmailVerifyConfirmRequest = z.input<typeof emailVerifyConfirmInputSchema>;

/* -------------------------------------------------------------------------- */
/* Sessions                                                                    */
/* -------------------------------------------------------------------------- */

/** One of the caller's own sessions (`GET /api/auth/sessions`). */
export interface SessionListItem {
  id: string;
  createdAt: string;
  lastUsedAt: string;
  expiresAt: string;
  /** Raw User-Agent, truncated server-side to 300 chars. */
  userAgent: string | null;
  ipAddress: string | null;
  /** True for the session making this request. */
  current: boolean;
}

export const sessionListItemSchema = z.object({
  id: idSchema,
  createdAt: dateTimeSchema,
  lastUsedAt: dateTimeSchema,
  expiresAt: dateTimeSchema,
  userAgent: z.string().max(300).nullable(),
  ipAddress: z.string().max(64).nullable(),
  current: z.boolean()
}) satisfies z.ZodType<SessionListItem>;

/* -------------------------------------------------------------------------- */
/* Invites (public side)                                                       */
/* -------------------------------------------------------------------------- */

/** `POST /api/invites/inspect` body. POST so the token stays out of URLs. */
export const inviteInspectInputSchema = z.object({ token: opaqueTokenSchema });
export type InviteInspectInput = z.infer<typeof inviteInspectInputSchema>;
export type InviteInspectRequest = z.input<typeof inviteInspectInputSchema>;

/**
 * Masks an email for display before acceptance: first local character, `***`,
 * first character of the first domain label, `***`, and the last label (TLD).
 * `"tia.lupe@example.com"` → `"t***@e***.com"`. Never reveals the full address,
 * so a token holder cannot learn which address to type into `accept`.
 */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at <= 0) return "***";
  const local = email.slice(0, at);
  const labels = email.slice(at + 1).split(".");
  const tld = labels.length > 1 ? labels[labels.length - 1] : undefined;
  const firstLabel = labels[0] ?? "";
  const domainHead = firstLabel.slice(0, 1) || "*";
  return `${local.slice(0, 1)}***@${domainHead}***${tld === undefined ? "" : `.${tld}`}`;
}

/** What an invitee may learn before accepting. Invalid tokens get 400 `INVITE_INVALID`. */
export interface InviteInspectResponse {
  /**
   * Masked bound email ({@link maskEmail}), or `null` for open invites. The
   * full address is never returned before acceptance: the invitee must type it.
   */
  emailMasked: string | null;
  role: UserRole;
  expiresAt: string;
  invitedByName: string | null;
  /** Suggested display name from the linked family-tree person, if any. */
  suggestedDisplayName: string | null;
}

export const inviteInspectResponseSchema = z.object({
  emailMasked: z.string().max(254).nullable(),
  role: userRoleSchema,
  expiresAt: dateTimeSchema,
  invitedByName: z.string().max(80).nullable(),
  suggestedDisplayName: z.string().max(200).nullable()
}) satisfies z.ZodType<InviteInspectResponse>;

/**
 * `POST /api/invites/accept`. Creates the account and logs in.
 * If the invite is bound to an email, `email` must equal it after
 * `emailSchema` normalization (otherwise generic 400 `INVITE_INVALID`).
 * The new user gets `emailVerified: true` only if the invite was bound to that
 * email **and** delivered by email (`sendEmail: true`); otherwise `false`.
 */
export const inviteAcceptInputSchema = z.object({
  token: opaqueTokenSchema,
  email: emailSchema,
  displayName: displayNameSchema,
  password: passwordSchema
});
export type InviteAcceptInput = z.infer<typeof inviteAcceptInputSchema>;
export type InviteAcceptRequest = z.input<typeof inviteAcceptInputSchema>;

/* -------------------------------------------------------------------------- */
/* Invites (admin side)                                                        */
/* -------------------------------------------------------------------------- */

/** Limits for open (not email-bound) member invites, which are shared as links. */
export const OPEN_INVITE_MAX_USES = 20;
export const OPEN_INVITE_MAX_DAYS = 14;

/**
 * `POST /api/admin/invites`.
 * - Admin invites: bound to an email, single-use, and **must be sent by email**
 *   (no copy-link), so holding the token implies controlling the mailbox.
 * - Open member invites (`email: null`): at most 20 uses and 14 days.
 */
export const adminInviteCreateInputSchema = z
  .object({
    /** Bind to an email (recommended). `null` = open invite (shared by WhatsApp). */
    email: emailSchema.nullable().default(null),
    role: userRoleSchema.default(UserRole.Member),
    maxUses: z.number().int().min(1).max(50).default(1),
    expiresInDays: z.number().int().min(1).max(30).default(7),
    /** Link the new account to an existing family-tree person. */
    personId: idSchema.nullable().default(null),
    /** Send the invite email via Resend. Requires `email`. */
    sendEmail: z.boolean().default(true),
    note: nullableTextSchema(200).default(null)
  })
  .refine((value) => !value.sendEmail || value.email !== null, {
    error: "Para enviar la invitación por correo necesitas un correo.",
    path: ["email"]
  })
  .refine((value) => value.role !== UserRole.Admin || value.maxUses === 1, {
    error: "Una invitación de administrador solo puede usarse una vez.",
    path: ["maxUses"]
  })
  .refine((value) => value.role !== UserRole.Admin || value.email !== null, {
    error: "Una invitación de administrador debe estar ligada a un correo.",
    path: ["email"]
  })
  .refine((value) => value.role !== UserRole.Admin || value.sendEmail, {
    error: "Una invitación de administrador debe enviarse por correo.",
    path: ["sendEmail"]
  })
  .refine((value) => value.email !== null || value.maxUses <= OPEN_INVITE_MAX_USES, {
    error: `Una invitación abierta admite como máximo ${OPEN_INVITE_MAX_USES} usos.`,
    path: ["maxUses"]
  })
  .refine((value) => value.email !== null || value.expiresInDays <= OPEN_INVITE_MAX_DAYS, {
    error: `Una invitación abierta dura como máximo ${OPEN_INVITE_MAX_DAYS} días.`,
    path: ["expiresInDays"]
  });
export type AdminInviteCreateInput = z.infer<typeof adminInviteCreateInputSchema>;
export type AdminInviteCreateRequest = z.input<typeof adminInviteCreateInputSchema>;

export const adminInviteListQuerySchema = cursorQuerySchema.extend({
  status: inviteStatusSchema.exactOptional()
});
export type AdminInviteListQuery = z.infer<typeof adminInviteListQuerySchema>;
export type AdminInviteListQueryRequest = z.input<typeof adminInviteListQuerySchema>;

/** Invite as seen by admins. Never includes the token or its hash. */
export interface AdminInviteListItem {
  id: string;
  email: string | null;
  role: UserRole;
  status: InviteStatus;
  maxUses: number;
  useCount: number;
  expiresAt: string;
  createdAt: string;
  createdByName: string | null;
  personId: string | null;
  note: string | null;
}

export const adminInviteListItemSchema = z.object({
  id: idSchema,
  email: z.string().max(254).nullable(),
  role: userRoleSchema,
  status: inviteStatusSchema,
  maxUses: z.number().int(),
  useCount: z.number().int(),
  expiresAt: dateTimeSchema,
  createdAt: dateTimeSchema,
  createdByName: z.string().max(80).nullable(),
  personId: idSchema.nullable(),
  note: z.string().max(200).nullable()
}) satisfies z.ZodType<AdminInviteListItem>;

/**
 * Response to invite creation. `inviteUrl` (`…/invitacion#t=…`) is shown
 * exactly once so the admin can share it; only its hash is stored.
 */
export interface AdminInviteCreated {
  invite: AdminInviteListItem;
  inviteUrl: string;
}

export const adminInviteCreatedSchema = z.object({
  invite: adminInviteListItemSchema,
  inviteUrl: z.string().max(2048)
}) satisfies z.ZodType<AdminInviteCreated>;
