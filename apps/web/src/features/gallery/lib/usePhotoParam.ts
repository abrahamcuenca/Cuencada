import { useCallback } from "react";
import { useSearchParams } from "react-router-dom";

/** URL parameter of the open photo: `?foto=<mediaId>` (WP-6.2 deep link; notifications link here). */
export const PHOTO_PARAM = "foto";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * @param value - `?foto=` from the URL (untrusted).
 * @returns The id when it is a UUID, else `null` (nothing is fetched for junk).
 */
export function photoIdFromParam(value: string | null): string | null {
  return value !== null && UUID.test(value) ? value.toLowerCase() : null;
}

/**
 * The open lightbox item, kept in `?foto=<id>` so a link opens the photo
 * (gallery, event albums, person photos and, from WP-6.3, Memory Box pages).
 * Changes replace the history entry, so Back leaves the page instead of
 * stepping through photos. Other query parameters are kept.
 *
 * @returns `[openId, setOpenId]`, a drop-in for `useState<string | null>`.
 */
export function usePhotoParam(): [string | null, (id: string | null) => void] {
  const [params, setParams] = useSearchParams();
  const openId = photoIdFromParam(params.get(PHOTO_PARAM));
  const setOpenId = useCallback(
    (id: string | null): void => {
      setParams(
        (current) => {
          const next = new URLSearchParams(current);
          if (id === null) next.delete(PHOTO_PARAM);
          else next.set(PHOTO_PARAM, id);
          return next;
        },
        { replace: true }
      );
    },
    [setParams]
  );
  return [openId, setOpenId];
}
