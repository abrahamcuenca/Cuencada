import { useEffect } from "react";
import { useLocation } from "react-router-dom";

/**
 * Once the page content exists, scrolls to the element named by the URL
 * fragment (e.g. `/perfil#contacto`) and moves keyboard focus to its heading
 * (`[data-section-heading]`, `tabIndex={-1}`), so screen-reader and keyboard
 * users land where the link promised. Runs again on every navigation
 * (`location.key`), so "Contacto" from the account menu works while already
 * on `/perfil`.
 *
 * Only ids in `allowed` are honoured: the fragment is user-controlled.
 *
 * @param ready - Whether the target section is rendered (profile loaded).
 * @param allowed - Section ids this page may scroll to.
 */
export function useScrollToSection(ready: boolean, allowed: readonly string[]): void {
  const { hash, key } = useLocation();
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` re-runs it for a repeated click on the same hash.
  useEffect(() => {
    if (!ready) return;
    const id = decodeFragment(hash);
    if (id === null || !allowed.includes(id)) return;
    const section = document.getElementById(id);
    if (section === null) return;
    // Optional call: jsdom and very old WebViews lack scrollIntoView. `scroll-margin-top` clears the sticky TopNav.
    section.scrollIntoView?.({ block: "start" });
    section.querySelector<HTMLElement>("[data-section-heading]")?.focus({ preventScroll: true });
  }, [ready, hash, key]);
}

/** `#contacto` → `contacto`; `null` for an empty or malformed fragment. */
function decodeFragment(hash: string): string | null {
  if (hash.length < 2) return null;
  try {
    return decodeURIComponent(hash.slice(1));
  } catch {
    // Malformed percent-encoding: no section matches it.
    return null;
  }
}
