/**
 * Token primitives: opaque single-use tokens (stored hashed), constant-time
 * comparison, and the short-lived HS256 access JWT.
 *
 * Access-token claims: `sub` (user id), `sid` (session id), `role`, `mcp`
 * (must change password), plus `iss`/`aud`/`iat`/`exp`. The claims are a
 * hint for the client only: the auth guard re-reads role and
 * must-change-password from the database on every request.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { type UserRole, userRoleSchema } from "@cuencada/types";
import { errors as joseErrors, jwtVerify, SignJWT } from "jose";
import { z } from "zod";
import type { AppConfig } from "../config.js";

/** `iss` of every access token. */
export const ACCESS_TOKEN_ISSUER = "cuencada-api";
/** `aud` of every access token. */
export const ACCESS_TOKEN_AUDIENCE = "cuencada-web";
const ACCESS_TOKEN_ALGORITHM = "HS256";

/** Bytes of entropy in an opaque token (256 bits → 43 base64url chars). */
const OPAQUE_TOKEN_BYTES = 32;

/**
 * Generate a URL-safe, 256-bit random token for invites, magic links, resets,
 * refresh tokens and chat tickets. Store only {@link hashToken} of it.
 */
export function createOpaqueToken(): string {
  return randomBytes(OPAQUE_TOKEN_BYTES).toString("base64url");
}

/**
 * SHA-256 hex digest of an opaque token, for storage and lookup. Opaque tokens
 * carry 256 bits of entropy, so an unsalted fast hash is appropriate here.
 *
 * @param token - The raw token as received from the client.
 */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Constant-time string comparison. Both sides are hashed first, so differing
 * lengths do not short-circuit and leak timing.
 *
 * @returns `true` when `a === b`.
 */
export function safeEqual(a: string, b: string): boolean {
  const left = createHash("sha256").update(a).digest();
  const right = createHash("sha256").update(b).digest();
  return timingSafeEqual(left, right);
}

/** Claims the server puts in an access token. */
export interface AccessTokenClaims {
  /** User id. */
  userId: string;
  /** Session id (`sessions.id`). */
  sessionId: string;
  role: UserRole;
  /** `mcp`: the user must change their password. */
  mustChangePassword: boolean;
}

/** A signed access token and its expiry. */
export interface SignedAccessToken {
  token: string;
  expiresAt: Date;
}

/** Settings for signing and verifying access tokens. */
export interface AccessTokenSettings {
  secret: Uint8Array;
  ttlSeconds: number;
}

/** Outcome of {@link verifyAccessToken}. */
export type AccessTokenVerification =
  | { ok: true; claims: AccessTokenClaims }
  | { ok: false; reason: "expired" | "invalid" };

const claimsSchema = z.object({
  sub: z.uuid(),
  sid: z.uuid(),
  role: userRoleSchema,
  mcp: z.boolean()
});

/**
 * Derive token settings from the app config.
 *
 * @param config - Needs `JWT_SECRET` and `ACCESS_TOKEN_TTL_SECONDS`.
 */
export function accessTokenSettings(
  config: Pick<AppConfig, "JWT_SECRET" | "ACCESS_TOKEN_TTL_SECONDS">
): AccessTokenSettings {
  return { secret: new TextEncoder().encode(config.JWT_SECRET), ttlSeconds: config.ACCESS_TOKEN_TTL_SECONDS };
}

/**
 * Sign an HS256 access token.
 *
 * @param settings - Secret and TTL.
 * @param claims - User, session, role and must-change flag.
 * @param now - Issue time (inject a clock in tests).
 */
export async function signAccessToken(
  settings: AccessTokenSettings,
  claims: AccessTokenClaims,
  now: Date = new Date()
): Promise<SignedAccessToken> {
  const issuedAt = Math.floor(now.getTime() / 1000);
  const expiresAtSeconds = issuedAt + settings.ttlSeconds;
  const token = await new SignJWT({ sid: claims.sessionId, role: claims.role, mcp: claims.mustChangePassword })
    .setProtectedHeader({ alg: ACCESS_TOKEN_ALGORITHM, typ: "JWT" })
    .setSubject(claims.userId)
    .setIssuer(ACCESS_TOKEN_ISSUER)
    .setAudience(ACCESS_TOKEN_AUDIENCE)
    .setIssuedAt(issuedAt)
    .setExpirationTime(expiresAtSeconds)
    .sign(settings.secret);
  return { token, expiresAt: new Date(expiresAtSeconds * 1000) };
}

/**
 * Verify an access token's signature (HS256 only), `iss`, `aud` and `exp`,
 * then the shape of its claims.
 *
 * @param settings - Secret (TTL unused).
 * @param token - The bearer token.
 * @param now - Verification time (inject a clock in tests).
 * @returns The claims, or why the token was rejected. Never throws.
 */
export async function verifyAccessToken(
  settings: AccessTokenSettings,
  token: string,
  now: Date = new Date()
): Promise<AccessTokenVerification> {
  try {
    const { payload } = await jwtVerify(token, settings.secret, {
      algorithms: [ACCESS_TOKEN_ALGORITHM],
      issuer: ACCESS_TOKEN_ISSUER,
      audience: ACCESS_TOKEN_AUDIENCE,
      requiredClaims: ["sub", "exp", "iat"],
      currentDate: now
    });
    const parsed = claimsSchema.safeParse(payload);
    if (!parsed.success) return { ok: false, reason: "invalid" };
    return {
      ok: true,
      claims: {
        userId: parsed.data.sub,
        sessionId: parsed.data.sid,
        role: parsed.data.role,
        mustChangePassword: parsed.data.mcp
      }
    };
  } catch (error) {
    if (error instanceof joseErrors.JWTExpired) return { ok: false, reason: "expired" };
    if (error instanceof joseErrors.JOSEError) return { ok: false, reason: "invalid" };
    throw error;
  }
}
