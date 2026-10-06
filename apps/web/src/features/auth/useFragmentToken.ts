import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { readAndScrubFragmentToken } from "../../shared/lib/fragmentToken";

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
  const location = useLocation();
  const navigate = useNavigate();

  useEffect(() => {
    if (location.hash === "") return;
    void navigate({ pathname: location.pathname, search: location.search }, { replace: true, state: location.state });
  }, [location.hash, location.pathname, location.search, location.state, navigate]);

  return token;
}
