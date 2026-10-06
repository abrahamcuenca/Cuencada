/**
 * Fragment tokens [SEC]: invite, magic-link, password-reset and
 * email-verification links carry their single-use token in the URL fragment
 * (`/invitacion#t=…`). Fragments are never sent to the server, so the token
 * stays out of access logs, proxies and the `Referer` header. The page still
 * has to remove it from the address bar and history as soon as it reads it,
 * so it can't be shoulder-surfed, synced or recovered with the Back button.
 */

/** Fragment parameter that carries the token. */
export const FRAGMENT_TOKEN_PARAM = "t";

// Same bounds as the contract's `opaqueTokenSchema` (32–256 base64url chars).
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{32,256}$/;

let cached: { pathname: string; token: string } | null = null;

/**
 * Reads `t` from `location.hash` and immediately scrubs the whole fragment
 * with `history.replaceState`. The path, query and router `history.state`
 * are kept.
 *
 * The fragment is scrubbed even when the token is malformed. A valid token is
 * also kept in memory for the current path, so calling this again on the same
 * page (StrictMode double render, re-mount) returns the same token instead of
 * `null`. Call {@link clearFragmentToken} once the token has been consumed.
 *
 * @returns The token, or `null` when it is absent or malformed.
 */
export function readAndScrubFragmentToken(): string | null {
  const { hash, pathname, search } = window.location;

  if (hash.length > 1) {
    window.history.replaceState(window.history.state, "", `${pathname}${search}`);
    const raw = new URLSearchParams(hash.slice(1)).get(FRAGMENT_TOKEN_PARAM);
    cached = raw !== null && TOKEN_SHAPE.test(raw) ? { pathname, token: raw } : null;
    return cached?.token ?? null;
  }

  return cached?.pathname === pathname ? cached.token : null;
}

/** Forgets the in-memory token (after it was consumed, on logout, or in tests). */
export function clearFragmentToken(): void {
  cached = null;
}
