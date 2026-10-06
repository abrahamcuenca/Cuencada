import { useEffect, useState } from "react";

/** Debounce delay for the admin search boxes. */
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
