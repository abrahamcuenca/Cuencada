import { useCallback, useRef } from "react";

/** Minimum time between two refetches caused by broken images. */
export const EXPIRED_URL_COOLDOWN_MS = 5 * 60_000;

/**
 * Presigned URLs expire after 1h. When an image or video fails to load, the
 * list is refetched once to get fresh URLs. A cooldown stops a genuinely
 * broken file from causing a refetch loop.
 *
 * @param refetch - Refetches the list (every loaded page).
 * @returns An `onError` handler for `<img>` / `<video>` (or an ancestor: React propagates media errors).
 */
export function useExpiredUrlRefetch(refetch: () => unknown): () => void {
  const last = useRef<number | null>(null);
  return useCallback(() => {
    const now = Date.now();
    if (last.current !== null && now - last.current < EXPIRED_URL_COOLDOWN_MS) return;
    last.current = now;
    refetch();
  }, [refetch]);
}
