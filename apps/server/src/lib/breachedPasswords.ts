/**
 * Breached-password check (ASVS 2.1.7) against Have I Been Pwned's
 * k-anonymity range API [SEC].
 *
 * - Only the first 5 hex characters of the password's SHA-1 leave the server
 *   (`GET https://api.pwnedpasswords.com/range/<prefix>`, `Add-Padding: true`).
 *   The 35-character suffix is compared locally against the returned list.
 * - The password, its hash and the suffix are never logged, cached or thrown.
 *   The optional cache holds only the public range data (suffix → count) keyed
 *   by the public prefix.
 * - **Fail-open:** a network error, timeout (1.5 s), oversized body or non-200
 *   answer allows the password and logs a structured warn
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
/** A padded range answer is ~800–1000 lines of ~40 bytes; anything far bigger is not HIBP. */
const MAX_RANGE_BODY_CHARS = 512 * 1024;
/** Cache bounds: prefixes kept and how long. Range data changes rarely. */
const CACHE_MAX_ENTRIES = 500;
const CACHE_TTL_MS = 10 * 60 * 1000;

const PREFIX_LENGTH = 5;
const RANGE_LINE = /^([0-9A-F]{35}):(\d{1,12})$/;

/** The `fetch` subset this module uses. Tests inject a fake (the only mocked boundary). */
export type RangeFetcher = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<Response>;

/** Minimal structured logger (pino / Fastify's `app.log` satisfy it). */
export interface BreachCheckLogger {
  warn(object: Record<string, unknown>, message: string): void;
}

/** Outcome of one check. `unavailable` and `skipped` both allow the password. */
export type BreachCheckOutcome = "breached" | "clean" | "unavailable" | "skipped";

/** Why a range lookup failed (logged; carries no secret). */
type UnavailableReason = "timeout" | "network" | "status" | "body";

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
  /** Defaults to `Date.now` (cache expiry only). */
  now?: () => number;
  /** Set to `0` to disable the prefix cache. */
  cacheMaxEntries?: number;
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

class RangeUnavailable extends Error {
  constructor(
    readonly reason: UnavailableReason,
    readonly status: number | null = null
  ) {
    super(`range lookup unavailable: ${reason}`);
    this.name = "RangeUnavailable";
  }
}

/** Small LRU of prefix → range data with a TTL. Holds public data only. */
class RangeCache {
  private readonly entries = new Map<string, { expiresAt: number; counts: Map<string, number> }>();

  constructor(
    private readonly maxEntries: number,
    private readonly now: () => number
  ) {}

  get(prefix: string): Map<string, number> | undefined {
    const entry = this.entries.get(prefix);
    if (entry === undefined) return undefined;
    this.entries.delete(prefix);
    if (entry.expiresAt <= this.now()) return undefined;
    this.entries.set(prefix, entry); // most recently used goes last
    return entry.counts;
  }

  set(prefix: string, counts: Map<string, number>): void {
    if (this.maxEntries <= 0) return;
    this.entries.delete(prefix);
    this.entries.set(prefix, { expiresAt: this.now() + CACHE_TTL_MS, counts });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
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
  const now = options.now ?? Date.now;
  const cache = new RangeCache(options.cacheMaxEntries ?? CACHE_MAX_ENTRIES, now);
  let unavailableCount = 0;

  async function fetchRange(prefix: string): Promise<Map<string, number>> {
    const signal = AbortSignal.timeout(timeoutMs);
    let response: Response;
    try {
      response = await fetcher(`${PWNED_RANGE_URL}${prefix}`, {
        headers: { "Add-Padding": "true", "User-Agent": "cuencada" },
        signal
      });
    } catch {
      throw new RangeUnavailable(signal.aborted ? "timeout" : "network");
    }
    if (response.status !== 200) {
      // Release the socket; the body is irrelevant.
      await response.body?.cancel().catch(() => undefined);
      throw new RangeUnavailable("status", response.status);
    }
    let body: string;
    try {
      body = await response.text();
    } catch {
      throw new RangeUnavailable(signal.aborted ? "timeout" : "body");
    }
    if (body.length > MAX_RANGE_BODY_CHARS) throw new RangeUnavailable("body");
    return parseRangeBody(body);
  }

  return {
    get unavailableCount() {
      return unavailableCount;
    },
    async check(password) {
      if (!options.enabled) return "skipped";
      const { prefix, suffix } = sha1Range(password);
      let counts = cache.get(prefix);
      if (counts === undefined) {
        try {
          counts = await fetchRange(prefix);
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
        cache.set(prefix, counts);
      }
      const count = counts.get(suffix) ?? 0;
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
