/**
 * The refresh-token cookie [SEC]: HttpOnly, SameSite=Strict, Path=/api/auth,
 * `Secure` per `COOKIE_SECURE`. Named `__Secure-cuencada_rt` when secure and
 * `cuencada_rt` otherwise (browsers drop `__Secure-` cookies without `Secure`).
 * The refresh token never appears in a JSON body.
 */
import { REFRESH_COOKIE, REFRESH_COOKIE_INSECURE } from "@cuencada/types";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { AppConfig } from "../../config.js";

/** Cookie path: the browser sends it only to `/api/auth/*` (refresh, logout). */
export const REFRESH_COOKIE_PATH = "/api/auth";

/** Shape of a refresh token we issued (`createOpaqueToken`, base64url, 43 chars). */
const REFRESH_TOKEN_FORMAT = /^[A-Za-z0-9_-]{32,256}$/;

type CookieConfig = Pick<AppConfig, "COOKIE_SECURE">;

/**
 * The cookie name for this environment.
 *
 * @param config - Needs `COOKIE_SECURE`.
 */
export function refreshCookieName(config: CookieConfig): string {
  return config.COOKIE_SECURE ? REFRESH_COOKIE : REFRESH_COOKIE_INSECURE;
}

function cookieOptions(config: CookieConfig): {
  path: string;
  httpOnly: true;
  secure: boolean;
  sameSite: "strict";
} {
  return { path: REFRESH_COOKIE_PATH, httpOnly: true, secure: config.COOKIE_SECURE, sameSite: "strict" };
}

/**
 * Read the refresh token from the request's cookie.
 *
 * @param request - Incoming request (`@fastify/cookie` parsed `cookies`).
 * @param config - Needs `COOKIE_SECURE`.
 * @returns The raw token, or `null` when missing or not shaped like one of ours.
 */
export function readRefreshCookie(request: FastifyRequest, config: CookieConfig): string | null {
  const value = request.cookies[refreshCookieName(config)];
  if (value === undefined || !REFRESH_TOKEN_FORMAT.test(value)) return null;
  return value;
}

/**
 * Set the refresh cookie. `Max-Age` runs until `expiresAt` (the session's idle
 * expiry, which is already capped at the absolute expiry).
 *
 * @param reply - The reply.
 * @param config - Needs `COOKIE_SECURE`.
 * @param token - Raw refresh token.
 * @param expiresAt - When the token (and the cookie) expire.
 * @param now - Current time.
 */
export function setRefreshCookie(
  reply: FastifyReply,
  config: CookieConfig,
  token: string,
  expiresAt: Date,
  now: Date
): void {
  const maxAge = Math.max(0, Math.floor((expiresAt.getTime() - now.getTime()) / 1000));
  void reply.setCookie(refreshCookieName(config), token, { ...cookieOptions(config), maxAge });
}

/**
 * Expire the refresh cookie in the browser.
 *
 * @param reply - The reply.
 * @param config - Needs `COOKIE_SECURE`.
 */
export function clearRefreshCookie(reply: FastifyReply, config: CookieConfig): void {
  void reply.clearCookie(refreshCookieName(config), cookieOptions(config));
}
