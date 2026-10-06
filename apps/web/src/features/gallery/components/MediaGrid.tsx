import type { MediaItem } from "@cuencada/types";
import { useEffect, useRef } from "react";
import { Button } from "../../../shared/ui/Button";
import { Skeleton } from "../../../shared/ui/Skeleton";
import styles from "../gallery.module.css";
import { mediaAlt } from "../lib/mediaText";

/** Thumbnails are 400px square-ish WebP; the tile is square, so declare a square box to avoid layout shift. */
const THUMB_SIZE = 400;

/** True when the item can be opened in the Lightbox. */
export function isViewable(item: MediaItem): boolean {
  return item.uploadStatus === "ready" && item.displayUrl !== null;
}

/** Props for {@link MediaGrid}. */
export interface MediaGridProps {
  items: readonly MediaItem[];
  /** Opens the item (by id) in the Lightbox. */
  onOpen: (id: string) => void;
  /** Called when a thumbnail fails to load (expired presigned URL). */
  onMediaError: () => void;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
}

/**
 * Responsive square thumbnail grid (3 columns on phones, up to 6 on desktop).
 * Loads the next page when the sentinel scrolls into view, with a button as
 * the fallback (and for keyboard and screen-reader users).
 */
export function MediaGrid({ items, onOpen, onMediaError, hasMore, loadingMore, onLoadMore }: MediaGridProps): React.ReactNode {
  const sentinel = useRef<HTMLDivElement>(null);
  const loadMore = useRef(onLoadMore);
  loadMore.current = onLoadMore;

  useEffect(() => {
    const node = sentinel.current;
    if (!node || !hasMore || loadingMore || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) loadMore.current();
      },
      { rootMargin: "600px 0px" }
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasMore, loadingMore]);

  return (
    <>
      <ul className={styles.grid} aria-label="Fotos y videos">
        {items.map((item) => (
          <li key={item.id} className={styles.tile}>
            <MediaTile item={item} onOpen={onOpen} onMediaError={onMediaError} />
          </li>
        ))}
      </ul>
      <div ref={sentinel} className={styles.more}>
        {hasMore ? (
          <Button variant="secondary" onClick={onLoadMore} loading={loadingMore}>
            Cargar más
          </Button>
        ) : null}
      </div>
    </>
  );
}

function MediaTile({ item, onOpen, onMediaError }: { item: MediaItem; onOpen: (id: string) => void; onMediaError: () => void }): React.ReactNode {
  if (item.uploadStatus !== "ready") {
    return (
      <div className={styles.processingTile} role="img" aria-label={`${mediaAlt(item)} (procesando)`}>
        {item.uploadStatus === "failed" ? "No se pudo procesar" : "Procesando…"}
      </div>
    );
  }
  const label = item.kind === "video" ? `Ver video: ${mediaAlt(item)}` : `Ver foto: ${mediaAlt(item)}`;
  return (
    <button type="button" className={styles.tileButton} onClick={() => onOpen(item.id)} aria-label={label} disabled={!isViewable(item)}>
      {item.thumbUrl ? (
        <img
          src={item.thumbUrl}
          alt=""
          width={THUMB_SIZE}
          height={THUMB_SIZE}
          loading="lazy"
          decoding="async"
          className={styles.thumb}
          onError={onMediaError}
        />
      ) : (
        <span aria-hidden="true" className={styles.videoPlaceholder}>
          ▶
        </span>
      )}
      {item.kind === "video" && item.thumbUrl ? (
        <span aria-hidden="true" className={styles.videoBadge}>
          ▶
        </span>
      ) : null}
    </button>
  );
}

/**
 * Placeholder grid while the first page loads.
 *
 * @param props - `count` of placeholder tiles.
 */
export function MediaGridSkeleton({ count = 12 }: { count?: number }): React.ReactNode {
  return (
    <ul className={styles.grid} aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders never reorder.
        <li key={i} className={styles.tile}>
          <Skeleton shape="block" height="100%" className={styles.skeletonTile} />
        </li>
      ))}
    </ul>
  );
}
