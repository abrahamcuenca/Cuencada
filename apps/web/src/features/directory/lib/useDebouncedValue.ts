import { useEffect, useState } from "react";

/**
 * @param value - The live value (e.g. what is typed in the search box).
 * @param delayMs - Quiet time before the value is taken.
 * @returns `value`, once it has not changed for `delayMs`.
 */
export function useDebouncedValue<TValue>(value: TValue, delayMs: number): TValue {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}
