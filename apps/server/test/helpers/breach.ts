import { type RangeFetcher, sha1Range } from "../../src/lib/breachedPasswords.js";

/** A fake HIBP range endpoint plus what it was asked. */
export interface FakeRange {
  fetcher: RangeFetcher;
  /** Every requested URL, in order. */
  urls: string[];
  /** Headers of the last request. */
  lastHeaders: Record<string, string> | null;
  /** `redirect` mode of the last request. */
  lastRedirect: string | null;
}

/** Behaviour of {@link fakeRange}. */
export interface FakeRangeOptions {
  /** HTTP status to answer (default 200). */
  status?: number;
  /** Reject like a network failure. */
  networkError?: boolean;
  /** Never answer; resolves only when the request's signal aborts (timeout). */
  hang?: boolean;
}

/**
 * Fake of `GET https://api.pwnedpasswords.com/range/<prefix>` (the only mocked
 * boundary of the breach check). Answers with CRLF lines like HIBP: one line
 * per breached password in the prefix (count 42), a padding line with count 0
 * and an unrelated suffix.
 *
 * @param breached - Passwords the fake reports as breached.
 * @param options - Failure modes.
 */
export function fakeRange(breached: readonly string[], options: FakeRangeOptions = {}): FakeRange {
  const state: FakeRange = { fetcher: async () => new Response(null), urls: [], lastHeaders: null, lastRedirect: null };
  state.fetcher = async (url, init) => {
    state.urls.push(url);
    state.lastHeaders = init.headers;
    state.lastRedirect = init.redirect;
    if (options.networkError === true) throw new TypeError("fetch failed");
    if (options.hang === true) {
      return new Promise<Response>((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
      });
    }
    const prefix = url.slice(-5);
    const lines = breached
      .map((password) => sha1Range(password))
      .filter((range) => range.prefix === prefix)
      .map((range) => `${range.suffix}:42`);
    lines.push(`${"0".repeat(35)}:0`, `${"F".repeat(35)}:3`);
    return new Response(lines.join("\r\n"), { status: options.status ?? 200 });
  };
  return state;
}
