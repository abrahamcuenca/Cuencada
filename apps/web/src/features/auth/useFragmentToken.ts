import { useCallback, useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { clearFragmentToken, readAndScrubFragmentToken } from "../../shared/lib/fragmentToken";

/** What {@link useConsumableFragmentToken} returns. */
export interface ConsumableFragmentToken {
  /** The token, or `null` when the link is missing, malformed or already discarded. */
  token: string | null;
  /**
   * Forgets the token everywhere [SEC]: the module stash (`clearFragmentToken`)
   * and this component's state. Call it once the POST consumed the token (or
   * the server rejected it), so a single-use credential does not linger in memory.
   */
  discard: () => void;
}

/**
 * Keeps the router location free of a hash. `bootstrapApp` already scrubbed
 * the real URL; an in-app navigation that still carries `#…` is replaced
 * without it so `useLocation().hash` never exposes the token.
 */
function useHashFreeLocation(): void {
  const location = useLocation();
  const navigate = useNavigate();

  useEffect(() => {
    if (location.hash === "") return;
    void navigate({ pathname: location.pathname, search: location.search }, { replace: true, state: location.state });
  }, [location.hash, location.pathname, location.search, location.state, navigate]);
}

/**
 * Returns the `#t=…` token for the current page. Use it in every
 * fragment-token page (`/entrar/enlace`, `/invitacion`, `/restablecer`,
 * `/verificar`).
 *
 * `bootstrapApp` already scrubbed the fragment before the router started and
 * kept the token in memory for this path. If the page was reached by an
 * in-app navigation that still carries a hash, this scrubs it too and
 * replaces the router location without the hash, so `useLocation().hash`
 * never exposes the token.
 *
 * @returns The token, or `null` when the link is missing or malformed.
 */
export function useFragmentToken(): string | null {
  const [token] = useState(readAndScrubFragmentToken);
  useHashFreeLocation();
  return token;
}

/**
 * Like {@link useFragmentToken}, plus a `discard()` that drops the token from
 * memory once it has been consumed. The T1 pages use this one.
 *
 * @returns The token and its `discard` function.
 */
export function useConsumableFragmentToken(): ConsumableFragmentToken {
  const [token, setToken] = useState(readAndScrubFragmentToken);
  useHashFreeLocation();
  const discard = useCallback((): void => {
    clearFragmentToken();
    setToken(null);
  }, []);
  return { token, discard };
}
