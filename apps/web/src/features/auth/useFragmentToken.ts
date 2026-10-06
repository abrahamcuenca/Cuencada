import { useState } from "react";
import { readAndScrubFragmentToken } from "../../shared/lib/fragmentToken";

/**
 * Reads the `#t=…` token for the current page once, on first render, and
 * scrubs it from the address bar and history. Use it in every fragment-token
 * page (`/entrar/enlace`, `/invitacion`, `/restablecer`, `/verificar`).
 *
 * @returns The token, or `null` when the link is missing or malformed.
 */
export function useFragmentToken(): string | null {
  const [token] = useState(readAndScrubFragmentToken);
  return token;
}
