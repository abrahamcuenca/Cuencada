/**
 * Two-step verification (TOTP, WP-7; ADR 0001 §9).
 *
 * Security rules encoded here:
 * - TOTP per RFC 6238: SHA-1, 6 digits, 30 s step, accepted window ±1 step,
 *   and a step is never accepted twice (replay prevention, server-side).
 * - A login of a user with 2FA does **not** issue a session. Login and
 *   magic-link consume answer {@link TwoFactorChallenge} instead; the opaque
 *   `challengeToken` (stored hashed, 5 minutes, at most 5 attempts) is kept in
 *   memory by the SPA only (never storage or the URL) and exchanged at
 *   `POST /api/auth/2fa/verify` for the usual {@link AuthTokenResponse}.
 * - Recovery codes are shown **once** (enable, regenerate) and stored hashed.
 * - Trusted devices ("Confiar en este dispositivo 30 días") are for members
 *   only: an HttpOnly, Secure, SameSite=Strict cookie on `/api/auth` holding
 *   an opaque token stored hashed. Administrators enter a code on every login.
 * - Mandatory for administrators: an admin whose session was not verified
 *   with a code answers 403 `TWO_FACTOR_SETUP_REQUIRED` on every route except
 *   `/me`, the 2FA status/setup/enable routes, logout and refresh.
 */
import { z } from "zod";
import { type AuthTokenResponse, authTokenResponseSchema, currentPasswordSchema } from "./auth.js";
import { dateTimeSchema, idSchema, opaqueTokenSchema } from "./common.js";

/* -------------------------------------------------------------------------- */
/* Constants                                                                   */
/* -------------------------------------------------------------------------- */

/** Digits of a TOTP code. */
export const TOTP_DIGITS = 6;
/** TOTP time step, in seconds. */
export const TOTP_PERIOD_SECONDS = 30;
/** Steps accepted on each side of the current one (clock drift). */
export const TOTP_WINDOW_STEPS = 1;
/** Recovery codes issued at enable and on regenerate. */
export const RECOVERY_CODE_COUNT = 10;
/** Characters of a recovery code, without separators (base32: 80 bits). */
export const RECOVERY_CODE_LENGTH = 16;
/** How long a login challenge lives, in minutes. */
export const TWO_FACTOR_CHALLENGE_TTL_MINUTES = 5;
/** Wrong codes allowed per challenge; the last one burns it. */
export const TWO_FACTOR_MAX_ATTEMPTS = 5;
/** Lifetime of a trusted device, in days (members only). */
export const TRUSTED_DEVICE_DAYS = 30;
/** Trusted-device cookie name when cookies are `Secure` (production). */
export const TRUSTED_DEVICE_COOKIE = "__Secure-cuencada_td";
/** Trusted-device cookie name over plain-http localhost (browsers drop `__Secure-` without `Secure`). */
export const TRUSTED_DEVICE_COOKIE_INSECURE = "cuencada_td";
/** Issuer shown in authenticator apps. */
export const TOTP_ISSUER = "Cuencada";

/* -------------------------------------------------------------------------- */
/* Inputs                                                                      */
/* -------------------------------------------------------------------------- */

const CODE_MESSAGE = `Escribe los ${TOTP_DIGITS} números de tu app.`;
const RECOVERY_MESSAGE = "Escribe un código de recuperación válido.";

/** A 6-digit TOTP code. Spaces are dropped (apps show "123 456"). */
export const totpCodeSchema = z
  .string()
  .max(20, { error: CODE_MESSAGE })
  .transform((value) => value.replace(/\s+/g, ""))
  .pipe(z.string().regex(/^\d{6}$/, { error: CODE_MESSAGE }));

/**
 * Normalize a typed recovery code: lowercase, without spaces or dashes.
 *
 * @param value - As typed, e.g. `"ABCD-EFGH-IJKL-MNOP"`.
 */
export function normalizeRecoveryCode(value: string): string {
  return value.toLowerCase().replace(/[\s-]+/g, "");
}

/** A recovery code (`xxxx-xxxx-xxxx-xxxx`, base32), compared after {@link normalizeRecoveryCode}. */
export const recoveryCodeSchema = z
  .string()
  .max(40, { error: RECOVERY_MESSAGE })
  .transform(normalizeRecoveryCode)
  .pipe(z.string().regex(/^[a-z2-7]{16}$/, { error: RECOVERY_MESSAGE }));

/** Exactly one of `code` and `recoveryCode`. */
function oneSecondFactor(value: { code?: string | undefined; recoveryCode?: string | undefined }): boolean {
  return (value.code === undefined) !== (value.recoveryCode === undefined);
}
const ONE_FACTOR_ERROR = { error: "Escribe un código de tu app o un código de recuperación.", path: ["code"] };

/**
 * `POST /api/auth/2fa/verify` (public): finish a login. A wrong code answers
 * 400 `TWO_FACTOR_INVALID` (generic: no hint about which part was wrong); an
 * unknown, expired, used or burned challenge answers 400 `TOKEN_INVALID`
 * (start the login again). `trustDevice` is ignored for administrators.
 */
export const twoFactorVerifyInputSchema = z
  .object({
    challengeToken: opaqueTokenSchema,
    code: totpCodeSchema.exactOptional(),
    recoveryCode: recoveryCodeSchema.exactOptional(),
    trustDevice: z.boolean().default(false)
  })
  .refine(oneSecondFactor, ONE_FACTOR_ERROR);
export type TwoFactorVerifyInput = z.infer<typeof twoFactorVerifyInputSchema>;
export type TwoFactorVerifyRequest = z.input<typeof twoFactorVerifyInputSchema>;

/**
 * `POST /api/auth/2fa/setup` (re-auth): the current password, unless the
 * session started less than {@link TWO_FACTOR_FRESH_LOGIN_MINUTES} ago.
 */
export const twoFactorSetupInputSchema = z.object({
  currentPassword: currentPasswordSchema.exactOptional()
});
export type TwoFactorSetupInput = z.infer<typeof twoFactorSetupInputSchema>;
export type TwoFactorSetupRequest = z.input<typeof twoFactorSetupInputSchema>;

/** A login this recent counts as re-authentication for setup. */
export const TWO_FACTOR_FRESH_LOGIN_MINUTES = 10;

/** `POST /api/auth/2fa/enable`: the first code from the app proves the pending secret. */
export const twoFactorEnableInputSchema = z.object({ code: totpCodeSchema });
export type TwoFactorEnableInput = z.infer<typeof twoFactorEnableInputSchema>;
export type TwoFactorEnableRequest = z.input<typeof twoFactorEnableInputSchema>;

/** `POST /api/auth/2fa/recovery-codes`: password + a current code; replaces every code. */
export const twoFactorRegenerateInputSchema = z.object({
  currentPassword: currentPasswordSchema,
  code: totpCodeSchema
});
export type TwoFactorRegenerateInput = z.infer<typeof twoFactorRegenerateInputSchema>;
export type TwoFactorRegenerateRequest = z.input<typeof twoFactorRegenerateInputSchema>;

/** `POST /api/auth/2fa/disable` (members only): password + a code or a recovery code. */
export const twoFactorDisableInputSchema = z
  .object({
    currentPassword: currentPasswordSchema,
    code: totpCodeSchema.exactOptional(),
    recoveryCode: recoveryCodeSchema.exactOptional()
  })
  .refine(oneSecondFactor, ONE_FACTOR_ERROR);
export type TwoFactorDisableInput = z.infer<typeof twoFactorDisableInputSchema>;
export type TwoFactorDisableRequest = z.input<typeof twoFactorDisableInputSchema>;

/* -------------------------------------------------------------------------- */
/* Responses                                                                   */
/* -------------------------------------------------------------------------- */

/** Login or magic-link consume for a user with 2FA: no session yet. */
export interface TwoFactorChallenge {
  twoFactorRequired: true;
  /** Opaque, single-use, 5 minutes. Keep it in memory only. */
  challengeToken: string;
  /** `false` for administrators: hide "Confiar en este dispositivo". */
  trustDeviceAllowed: boolean;
  /** ISO instant when the challenge expires. */
  expiresAt: string;
}

export const twoFactorChallengeSchema = z.object({
  twoFactorRequired: z.literal(true),
  challengeToken: z.string().max(256),
  trustDeviceAllowed: z.boolean(),
  expiresAt: dateTimeSchema
}) satisfies z.ZodType<TwoFactorChallenge>;

/** `POST /api/auth/login` and `POST /api/auth/magic-link/consume` (WP-7). */
export type LoginResponse = AuthTokenResponse | TwoFactorChallenge;
export const loginResponseSchema = z.union([twoFactorChallengeSchema, authTokenResponseSchema]);

/**
 * Type guard for the 2FA branch of {@link LoginResponse}.
 *
 * @param response - A login or magic-link response.
 */
export function isTwoFactorChallenge(response: LoginResponse): response is TwoFactorChallenge {
  return "twoFactorRequired" in response && response.twoFactorRequired;
}

/**
 * `POST /api/auth/2fa/setup`. The **only** response that ever carries the
 * secret: an `otpauth://` URI, the same as a QR code (SVG data URI rendered
 * server-side, no external request) and the manual-entry key. The secret is
 * pending (encrypted at rest) until `enable` proves it with a code.
 */
export interface TwoFactorSetup {
  otpauthUri: string;
  /** `data:image/svg+xml;base64,…` */
  qrSvgDataUri: string;
  /** Base32 key in groups of four for typing, e.g. `ABCD EFGH …`. */
  manualKey: string;
  issuer: string;
  /** The account name shown in the app (the email). */
  accountName: string;
}

export const twoFactorSetupSchema = z.object({
  otpauthUri: z.string().max(1024),
  qrSvgDataUri: z.string().max(200_000),
  manualKey: z.string().max(128),
  issuer: z.string().max(80),
  accountName: z.string().max(254)
}) satisfies z.ZodType<TwoFactorSetup>;

/** The recovery codes, shown once. */
export interface TwoFactorRecoveryCodes {
  /** {@link RECOVERY_CODE_COUNT} codes formatted `xxxx-xxxx-xxxx-xxxx`. */
  recoveryCodes: string[];
}

export const twoFactorRecoveryCodesSchema = z.object({
  recoveryCodes: z.array(z.string().max(40)).length(RECOVERY_CODE_COUNT)
}) satisfies z.ZodType<TwoFactorRecoveryCodes>;

/**
 * `POST /api/auth/2fa/enable`: the codes (once) plus a **re-issued** access
 * token whose session now counts as verified (`amr` includes `otp`). Other
 * sessions are closed; this one stays.
 */
export interface TwoFactorEnabled extends AuthTokenResponse, TwoFactorRecoveryCodes {}

export const twoFactorEnabledSchema = authTokenResponseSchema.extend(
  twoFactorRecoveryCodesSchema.shape
) satisfies z.ZodType<TwoFactorEnabled>;

/** `GET /api/auth/2fa/status`. */
export interface TwoFactorStatus {
  enabled: boolean;
  enabledAt: string | null;
  /** Administrators must have it (and cannot disable it). */
  required: boolean;
  /** Unused recovery codes (0 when disabled). */
  recoveryCodesRemaining: number;
  /** This session was verified with a code. */
  sessionVerified: boolean;
  /** Members may trust a device; administrators may not. */
  trustDeviceAllowed: boolean;
}

export const twoFactorStatusSchema = z.object({
  enabled: z.boolean(),
  enabledAt: dateTimeSchema.nullable(),
  required: z.boolean(),
  recoveryCodesRemaining: z.number().int().min(0).max(RECOVERY_CODE_COUNT),
  sessionVerified: z.boolean(),
  trustDeviceAllowed: z.boolean()
}) satisfies z.ZodType<TwoFactorStatus>;

/** One of the caller's trusted devices (`GET /api/auth/2fa/trusted-devices`). Never the token. */
export interface TrustedDevice {
  id: string;
  /** Coarse, e.g. "iPhone · Safari"; never the full User-Agent. */
  label: string;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string;
  /** This browser holds its cookie. */
  current: boolean;
}

export const trustedDeviceSchema = z.object({
  id: idSchema,
  label: z.string().max(80),
  createdAt: dateTimeSchema,
  lastUsedAt: dateTimeSchema.nullable(),
  expiresAt: dateTimeSchema,
  current: z.boolean()
}) satisfies z.ZodType<TrustedDevice>;

/** Most trusted devices listed (bounded by design). */
export const TRUSTED_DEVICES_LIST_MAX = 50;

/**
 * Format raw recovery-code characters as `xxxx-xxxx-xxxx-xxxx`.
 *
 * @param normalized - 16 base32 characters.
 */
export function formatRecoveryCode(normalized: string): string {
  return normalized.match(/.{1,4}/g)?.join("-") ?? normalized;
}
