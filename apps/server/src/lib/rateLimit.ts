/**
 * Per-route rate-limit configs for `@fastify/rate-limit`. Use them in a
 * route's `config.rateLimit`:
 *
 * ```ts
 * app.post("/auth/login", { config: { auth: "public", rateLimit: rateLimitByIpAndEmail({ max: 10, timeWindow: "15 minutes" }) } }, handler);
 * ```
 *
 * Keys use `request.ip`, which honours `TRUST_PROXY` (the client address
 * nginx forwards), never a raw `X-Forwarded-For` header. Emails in keys are
 * normalized and hashed, so the limiter's memory holds no PII.
 */
import { createHash } from "node:crypto";
import type { RateLimitOptions } from "@fastify/rate-limit";
import type { FastifyRequest } from "fastify";

/** How many requests per window. `timeWindow` is ms or a string like `"15 minutes"`. */
export interface RateLimitWindow {
  max: number;
  timeWindow: number | string;
}

/** Default global limit for routes without their own config. */
export const GLOBAL_RATE_LIMIT: RateLimitWindow = { max: 300, timeWindow: "1 minute" };

/**
 * Rate-limit key for the client IP. `request.ip` already applies `trustProxy`.
 *
 * @param request - Incoming request.
 */
export function ipKey(request: FastifyRequest): string {
  return `ip:${request.ip}`;
}

/**
 * Normalize an email for keying (trim + lowercase) and hash it.
 *
 * @param email - Raw email from the body, possibly not a string.
 * @returns A short stable hash, or `"none"` when there is no usable email.
 */
export function emailKeyPart(email: unknown): string {
  if (typeof email !== "string") return "none";
  const normalized = email.trim().toLowerCase();
  if (normalized === "") return "none";
  return createHash("sha256").update(normalized).digest("hex").slice(0, 32);
}

function bodyEmail(request: FastifyRequest): unknown {
  const body = request.body;
  if (typeof body !== "object" || body === null || !("email" in body)) return undefined;
  return body.email;
}

/**
 * Limit by client IP. Runs in `onRequest` (before the body is parsed).
 *
 * @param window - Max requests per time window.
 */
export function rateLimitByIp(window: RateLimitWindow): RateLimitOptions {
  return { ...window, keyGenerator: ipKey };
}

/**
 * Limit by client IP + the `email` field in the JSON body (login, magic link,
 * password reset). Runs in `preHandler`, after body validation, so the email
 * is available.
 *
 * @param window - Max requests per time window.
 */
export function rateLimitByIpAndEmail(window: RateLimitWindow): RateLimitOptions {
  return {
    ...window,
    hook: "preHandler",
    keyGenerator: (request) => `${ipKey(request)}|email:${emailKeyPart(bodyEmail(request))}`
  };
}

/**
 * Limit by the `email` field alone, across all IPs (slows distributed
 * attacks on one account). Combine with an IP limit on the same route via
 * a second limiter (`app.rateLimit(...)` in `preHandler`) if needed.
 *
 * @param window - Max requests per time window.
 */
export function rateLimitByEmail(window: RateLimitWindow): RateLimitOptions {
  return {
    ...window,
    hook: "preHandler",
    keyGenerator: (request) => `email:${emailKeyPart(bodyEmail(request))}`
  };
}
