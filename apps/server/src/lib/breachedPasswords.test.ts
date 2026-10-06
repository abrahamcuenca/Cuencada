import { describe, expect, it, vi } from "vitest";
import { fakeRange } from "../../test/helpers/breach.js";
import {
  assertPasswordNotBreached,
  BREACH_CHECK_UNAVAILABLE_EVENT,
  type BreachCheckerOptions,
  createBreachedPasswordChecker,
  parseRangeBody,
  PWNED_RANGE_URL,
  sha1Range
} from "./breachedPasswords.js";
import { AppError } from "./errors.js";

const BREACHED = "contraseña-filtrada-de-prueba";
const CLEAN = "una frase larga que nadie filtró";

function checker(overrides: Partial<BreachCheckerOptions> & Pick<BreachCheckerOptions, "fetcher">) {
  const logger = { warn: vi.fn() };
  return { logger, checker: createBreachedPasswordChecker({ enabled: true, minCount: 1, logger, ...overrides }) };
}

describe("sha1Range", () => {
  it("splits the uppercase SHA-1 into a 5-char prefix and a 35-char suffix", () => {
    // SHA-1("password") = 5BAA61E4C9B93F3F0682250B6CF8331B7EE68FD8 (public test vector).
    expect(sha1Range("password")).toEqual({ prefix: "5BAA6", suffix: "1E4C9B93F3F0682250B6CF8331B7EE68FD8" });
  });
});

describe("parseRangeBody", () => {
  it("drops padding entries with a count of 0 and malformed lines", () => {
    const suffix = "A".repeat(35);
    const counts = parseRangeBody(`${suffix}:7\r\n${"B".repeat(35)}:0\r\nnot-a-line\r\n${"c".repeat(35)}:2\n`);
    expect([...counts]).toEqual([
      [suffix, 7],
      ["C".repeat(35), 2]
    ]);
  });
});

describe("createBreachedPasswordChecker", () => {
  it("sends only the 5-char prefix, with padding and the user agent, and reports a breached password", async () => {
    const range = fakeRange([BREACHED]);
    const { checker: subject } = checker({ fetcher: range.fetcher });

    expect(await subject.check(BREACHED)).toBe("breached");
    const { prefix, suffix } = sha1Range(BREACHED);
    expect(range.urls).toEqual([`${PWNED_RANGE_URL}${prefix}`]);
    expect(range.urls[0]).not.toContain(suffix);
    expect(range.lastHeaders).toEqual({ "Add-Padding": "true", "User-Agent": "cuencada" });
  });

  it("reports a password whose suffix is absent as clean", async () => {
    const { checker: subject } = checker({ fetcher: fakeRange([BREACHED]).fetcher });
    expect(await subject.check(CLEAN)).toBe("clean");
  });

  it("ignores a padding entry (count 0) for the password's own suffix", async () => {
    const { suffix } = sha1Range(CLEAN);
    const { checker: subject } = checker({ fetcher: async () => new Response(`${suffix}:0\r\n`) });
    expect(await subject.check(CLEAN)).toBe("clean");
  });

  it("rejects only at or above the configured threshold", async () => {
    const range = fakeRange([BREACHED]); // count 42
    expect(await checker({ fetcher: range.fetcher, minCount: 42 }).checker.check(BREACHED)).toBe("breached");
    expect(await checker({ fetcher: range.fetcher, minCount: 43 }).checker.check(BREACHED)).toBe("clean");
  });

  it("skips without any request when disabled", async () => {
    const range = fakeRange([BREACHED]);
    const { checker: subject } = checker({ fetcher: range.fetcher, enabled: false });
    expect(await subject.check(BREACHED)).toBe("skipped");
    expect(range.urls).toEqual([]);
  });

  it("fails open on a timeout and logs a warn with a counter and no secret data", async () => {
    const { checker: subject, logger } = checker({ fetcher: fakeRange([BREACHED], { hang: true }).fetcher, timeoutMs: 20 });

    expect(await subject.check(BREACHED)).toBe("unavailable");
    expect(await subject.check(BREACHED)).toBe("unavailable");
    expect(subject.unavailableCount).toBe(2);
    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenLastCalledWith(
      { event: BREACH_CHECK_UNAVAILABLE_EVENT, reason: "timeout", unavailableTotal: 2 },
      expect.any(String)
    );
    const logged = JSON.stringify(logger.warn.mock.calls);
    const { prefix, suffix } = sha1Range(BREACHED);
    for (const secret of [BREACHED, prefix + suffix, suffix, prefix]) expect(logged).not.toContain(secret);
  });

  it("fails open on a non-200 answer and on a network error", async () => {
    const down = checker({ fetcher: fakeRange([BREACHED], { status: 503 }).fetcher });
    expect(await down.checker.check(BREACHED)).toBe("unavailable");
    expect(down.logger.warn).toHaveBeenCalledWith(
      { event: BREACH_CHECK_UNAVAILABLE_EVENT, reason: "status", upstreamStatus: 503, unavailableTotal: 1 },
      expect.any(String)
    );

    const offline = checker({ fetcher: fakeRange([BREACHED], { networkError: true }).fetcher });
    expect(await offline.checker.check(BREACHED)).toBe("unavailable");
    expect(offline.logger.warn).toHaveBeenCalledWith(
      { event: BREACH_CHECK_UNAVAILABLE_EVENT, reason: "network", unavailableTotal: 1 },
      expect.any(String)
    );
    expect(JSON.stringify([down.logger.warn.mock.calls, offline.logger.warn.mock.calls])).not.toContain(BREACHED);
  });

  it("caches a prefix's range until the TTL passes, and evicts the least recently used prefix", async () => {
    let now = 0;
    const range = fakeRange([BREACHED]);
    const { checker: subject } = checker({ fetcher: range.fetcher, now: () => now, cacheMaxEntries: 1 });

    await subject.check(BREACHED);
    await subject.check(BREACHED);
    expect(range.urls).toHaveLength(1);

    now += 11 * 60 * 1000;
    await subject.check(BREACHED);
    expect(range.urls).toHaveLength(2);

    await subject.check(CLEAN); // different prefix evicts the first (max 1 entry)
    await subject.check(BREACHED);
    expect(range.urls).toHaveLength(4);
  });

  it("does not cache a failed lookup", async () => {
    let fail = true;
    const range = fakeRange([BREACHED]);
    const { checker: subject } = checker({
      fetcher: async (url, init) => (fail ? new Response("", { status: 500 }) : range.fetcher(url, init))
    });
    expect(await subject.check(BREACHED)).toBe("unavailable");
    fail = false;
    expect(await subject.check(BREACHED)).toBe("breached");
  });
});

describe("assertPasswordNotBreached", () => {
  it("throws 400 VALIDATION with a PASSWORD_BREACHED detail on the given path", async () => {
    const { checker: subject } = checker({ fetcher: fakeRange([BREACHED]).fetcher });
    const error = await assertPasswordNotBreached(subject, BREACHED, "newPassword").catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({
      code: "VALIDATION",
      statusCode: 400,
      details: [
        {
          path: "newPassword",
          code: "PASSWORD_BREACHED",
          message: "Esta contraseña apareció en filtraciones de datos conocidas. Elige otra."
        }
      ]
    });
  });

  it("allows a clean password and fails open when the service is unavailable", async () => {
    await expect(assertPasswordNotBreached(checker({ fetcher: fakeRange([BREACHED]).fetcher }).checker, CLEAN, "password")).resolves.toBeUndefined();
    const offline = checker({ fetcher: fakeRange([BREACHED], { networkError: true }).fetcher }).checker;
    await expect(assertPasswordNotBreached(offline, BREACHED, "password")).resolves.toBeUndefined();
  });
});
