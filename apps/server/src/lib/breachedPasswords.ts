/**
 * Breached-password check (ASVS 2.1.7) against Have I Been Pwned's
 * k-anonymity range API [SEC].
 *
 * - Only the first 5 hex characters of the password's SHA-1 leave the server
 *   (`GET https://api.pwnedpasswords.com/range/<prefix>`, `Add-Padding: true`).
 *   The 35-character suffix is compared locally against the returned list.
 * - The password, its hash and the suffix are never logged, stored or thrown.
 * - **No result cache, on purpose** (Security review): a cached answer is
 *   faster, so the response time of a dead-token reset or invite accept would
 *   reveal that someone chose or tried that exact password recently. Every
 *   check makes one range request; HIBP ranges are CDN-served, the call is
 *   capped at 1.5 s, and the routes' rate limits bound the volume.
 * - **Fail-open:** a network error, timeout (1.5 s), redirect (fetch uses
 *   `redirect: "error"`), oversized body (checked against `content-length`
 *   first, then with a running byte cap while streaming) or non-200 answer
 *   allows the password and logs a structured warn
 *   `password.breach_check_unavailable` with a running counter. An outage of a
 *   third-party service must not block every signup, reset and change; the
 *   length policy still applies, and the counter makes a prolonged outage
 *   visible in the logs.
 */
import { createHash } from "node:crypto";
import { PASSWORD_BREACHED_MESSAGE, ValidationIssueCode } from "@cuencada/types";
import { AppError } from "./errors.js";

/** HIBP range endpoint (the 5-char prefix is appended). */
export const PWNED_RANGE_URL = "https://api.pwnedpasswords.com/range/";
/** Default timeout for one range request, headers and body included. */
export const BREACH_CHECK_TIMEOUT_MS = 1500;
/** A padded range answer is ~800–1000 lines of ~40 bytes (~40 KB); anything far bigger is not HIBP. */
export const MAX_RANGE_BODY_BYTES = 512 * 1024;

const PREFIX_LENGTH = 5;
const RANGE_LINE = /^([0-9A-F]{35}):(\d{1,12})$/;

/** The `fetch` subset this module uses. Tests inject a fake (the only mocked boundary). */
export type RangeFetcher = (
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal; redirect: "error" }
) => Promise<Response>;

/** Minimal structured logger (pino / Fastify's `app.log` satisfy it). */
export interface BreachCheckLogger {
  warn(object: Record<string, unknown>, message: string): void;
}

/** Outcome of one check. `unavailable` and `skipped` both allow the password. */
export type BreachCheckOutcome = "breached" | "clean" | "unavailable" | "skipped";

/** Why a range lookup failed (logged; carries no secret). */
type UnavailableReason = "timeout" | "network" | "status" | "redirect" | "oversized" | "body";

/** The checker the routes and the seed use. */
export interface BreachedPasswordChecker {
  /**
   * @param password - Plaintext candidate (already past `passwordSchema`).
   * @returns `breached` when it appears in at least `minCount` breaches.
   */
  check(password: string): Promise<BreachCheckOutcome>;
  /** Range lookups that failed open since start (also in each warn log). */
  readonly unavailableCount: number;
}

/** Options for {@link createBreachedPasswordChecker}. */
export interface BreachCheckerOptions {
  /** `false` turns every check into `skipped` (config `PASSWORD_BREACH_CHECK=off`). */
  enabled: boolean;
  /** Reject when the breach count is at least this (ASVS default: 1). */
  minCount: number;
  logger: BreachCheckLogger;
  /** Defaults to the global `fetch`. */
  fetcher?: RangeFetcher;
  timeoutMs?: number;
}

/** Event name of the fail-open warn log. */
export const BREACH_CHECK_UNAVAILABLE_EVENT = "password.breach_check_unavailable";

/**
 * Split a password's uppercase SHA-1 into the public prefix and the private suffix.
 *
 * @param password - Plaintext (hashed as UTF-8, like HIBP).
 * @returns `{ prefix, suffix }`; only `prefix` may leave the process.
 */
export function sha1Range(password: string): { prefix: string; suffix: string } {
  const digest = createHash("sha1").update(password, "utf8").digest("hex").toUpperCase();
  return { prefix: digest.slice(0, PREFIX_LENGTH), suffix: digest.slice(PREFIX_LENGTH) };
}

/**
 * Parse a range answer into suffix → count. Padding entries (count 0) and
 * malformed lines are dropped.
 *
 * @param body - Response text (`SUFFIX:COUNT` per line, CRLF or LF).
 */
export function parseRangeBody(body: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const raw of body.split("\n")) {
    const match = RANGE_LINE.exec(raw.trim().toUpperCase());
    if (match === null) continue;
    const [, suffix, countText] = match;
    if (suffix === undefined || countText === undefined) continue;
    const count = Number(countText);
    if (count > 0) counts.set(suffix, count);
  }
  return counts;
}

/**
 * Read a response body as UTF-8 with a running byte cap. Past
 * {@link MAX_RANGE_BODY_BYTES} it aborts the request instead of buffering more.
 *
 * @param response - A 200 answer.
 * @param controller - The request's controller (aborted on overflow).
 * @param timedOut - Whether the timeout fired (distinguishes the failure reason).
 */
async function readCapped(response: Response, controller: AbortController, timedOut: () => boolean): Promise<string> {
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > MAX_RANGE_BODY_BYTES) {
        controller.abort();
        await reader.cancel().catch(() => undefined);
        throw new RangeUnavailable("oversized");
      }
      text += decoder.decode(value, { stream: true });
    }
  } catch (error) {
    if (error instanceof RangeUnavailable) throw error;
    throw new RangeUnavailable(timedOut() ? "timeout" : "body");
  }
  return text + decoder.decode();
}

class RangeUnavailable extends Error {
  constructor(
    readonly reason: UnavailableReason,
    readonly status: number | null = null
  ) {
    super(`range lookup unavailable: ${reason}`);
    this.name = "RangeUnavailable";
  }
}

/**
 * Build a breached-password checker.
 *
 * @param options - Enable flag, threshold, logger and (in tests) a fake fetcher.
 * @returns The checker. It never throws for an unavailable range service.
 */
export function createBreachedPasswordChecker(options: BreachCheckerOptions): BreachedPasswordChecker {
  const fetcher: RangeFetcher = options.fetcher ?? ((url, init) => fetch(url, init));
  const timeoutMs = options.timeoutMs ?? BREACH_CHECK_TIMEOUT_MS;
  let unavailableCount = 0;

  async function fetchRange(prefix: string): Promise<Map<string, number>> {
    // One controller for the timeout and the body cap, so either aborts the socket.
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    try {
      let response: Response;
      try {
        response = await fetcher(`${PWNED_RANGE_URL}${prefix}`, {
          headers: { "Add-Padding": "true", "User-Agent": "cuencada" },
          signal: controller.signal,
          // Never follow a redirect off api.pwnedpasswords.com (fetch rejects it: fail-open).
          redirect: "error"
        });
      } catch {
        throw new RangeUnavailable(timedOut ? "timeout" : "network");
      }
      if (response.status !== 200) {
        controller.abort(); // the body is irrelevant; release the socket
        const redirect = response.status >= 300 && response.status < 400;
        throw new RangeUnavailable(redirect ? "redirect" : "status", response.status);
      }
      const declared = Number(response.headers.get("content-length") ?? Number.NaN);
      if (Number.isFinite(declared) && declared > MAX_RANGE_BODY_BYTES) {
        controller.abort();
        throw new RangeUnavailable("oversized");
      }
      const body = await readCapped(response, controller, () => timedOut);
      return parseRangeBody(body);
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    get unavailableCount() {
      return unavailableCount;
    },
    async check(password) {
      if (!options.enabled) return "skipped";
      const { prefix, suffix } = sha1Range(password);
      let count: number;
      try {
        count = (await fetchRange(prefix)).get(suffix) ?? 0;
      } catch (error) {
        if (!(error instanceof RangeUnavailable)) throw error;
        unavailableCount += 1;
        // No password, hash, prefix or suffix here: only the failure kind and the counter.
        options.logger.warn(
          {
            event: BREACH_CHECK_UNAVAILABLE_EVENT,
            reason: error.reason,
            ...(error.status === null ? {} : { upstreamStatus: error.status }),
            unavailableTotal: unavailableCount
          },
          "breached-password check unavailable; allowing (fail-open)"
        );
        return "unavailable";
      }
      return count >= options.minCount ? "breached" : "clean";
    }
  };
}

/**
 * Route guard: throw 400 `VALIDATION` on `path` when the new password is
 * breached. Call it after the body schema passed and **before** any argon2
 * hashing, token consumption or DB write, so a rejected password costs
 * nothing and burns no single-use token.
 *
 * @param checker - `app.breachedPasswords`.
 * @param password - The new password (plaintext; never logged).
 * @param path - The body field that carries it (`password` or `newPassword`).
 * @throws AppError `VALIDATION` with a `PASSWORD_BREACHED` detail on `path`.
 */
export async function assertPasswordNotBreached(
  checker: BreachedPasswordChecker,
  password: string,
  path: string
): Promise<void> {
  if ((await checker.check(password)) !== "breached") return;
  throw new AppError("VALIDATION", undefined, {
    details: [{ path, message: PASSWORD_BREACHED_MESSAGE, code: ValidationIssueCode.PASSWORD_BREACHED }]
  });
}
