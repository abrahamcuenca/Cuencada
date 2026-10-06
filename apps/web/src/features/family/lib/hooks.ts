import { useEffect, useState } from "react";

/** Debounce delay for the people search boxes. */
export const SEARCH_DEBOUNCE_MS = 300;

/**
 * @param value - A fast-changing value (e.g. a search box).
 * @param delayMs - Quiet time before the value is committed.
 * @returns `value`, updated only after it stopped changing for `delayMs`.
 */
export function useDebouncedValue<TValue>(value: TValue, delayMs: number = SEARCH_DEBOUNCE_MS): TValue {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

function readReducedMotion(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia(REDUCED_MOTION_QUERY).matches;
}

/**
 * @returns Whether the user asked the OS for reduced motion (live-updating).
 */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(readReducedMotion);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return undefined;
    const query = window.matchMedia(REDUCED_MOTION_QUERY);
    const onChange = (): void => setReduced(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  return reduced;
}
