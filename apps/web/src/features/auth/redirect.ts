/** Where to send a user after login when there is no safe `from` location. */
export const DEFAULT_AFTER_LOGIN_PATH = "/";

/** Router `state` that `RequireAuth` attaches when redirecting to `/entrar`. */
export interface LoginRedirectState {
  /** Path + query of the page the user tried to open. Never includes the hash. */
  from: string;
}

/**
 * Returns a same-origin path to navigate to after login [SEC].
 *
 * Rejects absolute URLs, protocol-relative `//evil.example`, backslash tricks
 * and anything not starting with a single `/`, so a crafted link cannot turn
 * the login page into an open redirect.
 *
 * @param value - Candidate path, e.g. `location.state?.from`.
 * @returns The path if safe, otherwise {@link DEFAULT_AFTER_LOGIN_PATH}.
 */
export function safeRedirectPath(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048) return DEFAULT_AFTER_LOGIN_PATH;
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return DEFAULT_AFTER_LOGIN_PATH;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point.
  if (/[\u0000-\u001f\u007f]/.test(value)) return DEFAULT_AFTER_LOGIN_PATH;
  return value;
}

/**
 * Reads `from` out of router location state.
 *
 * @param state - `useLocation().state` (unknown by design).
 * @returns A safe post-login path.
 */
export function redirectPathFromState(state: unknown): string {
  if (typeof state !== "object" || state === null || !("from" in state)) return DEFAULT_AFTER_LOGIN_PATH;
  return safeRedirectPath(state.from);
}
