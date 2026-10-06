import { useEffect, useMemo, useRef, useState } from "react";
import { useAppSelector } from "../../../app/hooks";
import { baseApi } from "../../../shared/api/baseApi";
import { collectPersonNames } from "./tree";

/** Endpoints whose cached data carries person names. */
const NAME_ENDPOINTS: ReadonlySet<string> = new Set(["getFamilyTree", "searchPeople", "getPerson"]);

/**
 * Person id → full name from memory only: every tree view / people page in
 * the RTK Query cache, plus the names seen while this component is mounted
 * (so breadcrumbs survive the cache letting go of an old view). Nothing is
 * read from or written to history or web storage.
 *
 * @returns The names known right now.
 */
export function useCachedPersonNames(): ReadonlyMap<string, string> {
  const queries = useAppSelector((state) => state[baseApi.reducerPath].queries);
  const seen = useRef(new Map<string, string>());
  return useMemo(() => {
    for (const entry of Object.values(queries)) {
      if (entry?.status === "fulfilled" && NAME_ENDPOINTS.has(entry.endpointName)) collectPersonNames(entry.data, seen.current);
    }
    return new Map(seen.current);
  }, [queries]);
}

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
