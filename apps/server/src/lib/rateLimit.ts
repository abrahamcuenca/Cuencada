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
import type { CreateRateLimitOptions, RateLimitOptions } from "@fastify/rate-limit";
import type { FastifyReply, FastifyRequest } from "fastify";
import { AppError } from "./errors.js";

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
 * is available. Requests rejected by validation (malformed bodies) never
 * reach it and are bounded only by the global per-IP limit.
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

/** Windows for credential endpoints (login; reuse for magic-link/reset/change-password in T1). */
export interface CredentialRateLimits {
  /** Same IP + same email (brute force on one account from one place). */
  ipAndEmail: RateLimitWindow;
  /** Same IP across all emails (password spraying). */
  ip: RateLimitWindow;
  /** Same email across all IPs (distributed attack on one account). */
  email: RateLimitWindow;
}

/** Default credential limits: 10 per IP+email, 20 per IP, 10 per email, each per 15 minutes. */
export const LOGIN_RATE_LIMITS: CredentialRateLimits = {
  ipAndEmail: { max: 10, timeWindow: "15 minutes" },
  ip: { max: 20, timeWindow: "15 minutes" },
  email: { max: 10, timeWindow: "15 minutes" }
};

/** Result of a `createRateLimit()` check (the fields we use). */
type RateLimitCheck = { isAllowed: true } | { isAllowed: false; isExceeded: boolean; ttlInSeconds: number };

/** What {@link credentialRateLimits} needs from the app: `@fastify/rate-limit`'s `createRateLimit()` decorator. */
export interface RateLimitFactory {
  createRateLimit(options?: CreateRateLimitOptions): (request: FastifyRequest) => Promise<RateLimitCheck>;
}

/** A `preHandler` hook that enforces one extra limiter. */
export type RateLimitHook = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

/**
 * Turn a limiter into a hook. `@fastify/rate-limit`'s own `app.rateLimit()`
 * hooks mark the request as limited and skip every later limiter, so several
 * caps on one route must use `createRateLimit()` like this. Add the hook to a
 * route's `preHandler` (alongside its `config.rateLimit`).
 *
 * @param factory - The Fastify instance.
 * @param options - Window plus a `keyGenerator` with a prefix unique to this cap.
 */
export function extraRateLimitHook(factory: RateLimitFactory, options: CreateRateLimitOptions): RateLimitHook {
  const check = factory.createRateLimit(options);
  return async (request, reply) => {
    const result = await check(request);
    if (!result.isAllowed && result.isExceeded) {
      void reply.header("retry-after", String(result.ttlInSeconds));
      throw new AppError("RATE_LIMITED");
    }
  };
}

/**
 * Route options for a credential endpoint: the IP+email limiter as the
 * route's `config.rateLimit`, plus `preHandler` hooks for the per-IP cap
 * (password spraying) and the per-email cap across IPs (distributed attacks).
 * Each call creates its own counters, so call it once per route.
 *
 * ```ts
 * const limits = credentialRateLimits(app);
 * app.post("/auth/login", { config: { auth: "public", rateLimit: limits.rateLimit }, preHandler: limits.preHandler, schema }, handler);
 * ```
 *
 * @param app - The Fastify instance (`createRateLimit` comes from `@fastify/rate-limit`).
 * @param limits - Windows; defaults to {@link LOGIN_RATE_LIMITS}.
 */
export function credentialRateLimits(
  app: RateLimitFactory,
  limits: CredentialRateLimits = LOGIN_RATE_LIMITS
): { rateLimit: RateLimitOptions; preHandler: RateLimitHook[] } {
  return {
    rateLimit: rateLimitByIpAndEmail(limits.ipAndEmail),
    preHandler: [
      extraRateLimitHook(app, { ...limits.ip, keyGenerator: (request) => `credential-${ipKey(request)}` }),
      extraRateLimitHook(app, { ...limits.email, keyGenerator: (request) => `credential-email:${emailKeyPart(bodyEmail(request))}` })
    ]
  };
}
