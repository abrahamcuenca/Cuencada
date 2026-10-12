import { useCallback, useSyncExternalStore } from "react";

function mediaQueryList(query: string): MediaQueryList | null {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(query) : null;
}

/**
 * Whether a CSS media query matches, kept live. `false` where `matchMedia`
 * is missing (old WebViews, server rendering).
 *
 * @param query - e.g. `"(min-width: 1000px)"`.
 * @returns The current match.
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void): (() => void) => {
      const list = mediaQueryList(query);
      if (list === null) return () => undefined;
      list.addEventListener("change", onChange);
      return () => list.removeEventListener("change", onChange);
    },
    [query]
  );
  const read = (): boolean => mediaQueryList(query)?.matches ?? false;
  return useSyncExternalStore(subscribe, read, () => false);
}
