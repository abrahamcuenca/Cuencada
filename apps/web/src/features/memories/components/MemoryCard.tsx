/**
 * A box card (WP-6.3): the cover (or a placeholder), the title (the link,
 * stretched over the whole card: one tap target, one tab stop), the photo
 * count and, outside the compact Home strip, the description.
 */
import type { MemoryAlbumSummary } from "@cuencada/types";
import { type ReactNode, useState } from "react";
import { Link } from "react-router-dom";
import { cx } from "../../../shared/ui/cx";
import { mediaCountLabel, memoryPath } from "../lib/format";
import styles from "../memories.module.css";

/** Props for {@link MemoryCover}. */
export interface MemoryCoverProps {
  /** Presigned 400 px thumbnail, or `null`. */
  url: string | null;
  /** An expired presigned URL: ask the owner to refetch. */
  onError?: (() => void) | undefined;
  className?: string | undefined;
}

/**
 * A 4:3 cover, decorative (the title is next to it). Without a cover, or
 * when it fails to load, a warm "old photo" placeholder holds the same box,
 * so nothing shifts.
 */
export function MemoryCover({ url, onError, className }: MemoryCoverProps): ReactNode {
  const [failed, setFailed] = useState<string | null>(null);
  const showImage = url !== null && failed !== url;
  return (
    <div className={cx(styles.cover, className)}>
      {showImage ? (
        <img
          src={url}
          alt=""
          width={400}
          height={300}
          loading="lazy"
          decoding="async"
          className={styles.coverImage}
          onError={() => {
            setFailed(url);
            onError?.();
          }}
        />
      ) : (
        <span aria-hidden="true" className={styles.coverPlaceholder}>
          🗃️
        </span>
      )}
    </div>
  );
}

/** Props for {@link MemoryCard}. */
export interface MemoryCardProps {
  box: MemoryAlbumSummary;
  /** Home's strip: no description. */
  compact?: boolean;
  headingLevel?: 2 | 3;
  onMediaError?: () => void;
}

/** One box in a list. */
export function MemoryCard({ box, compact = false, headingLevel = 2, onMediaError }: MemoryCardProps): ReactNode {
  const Heading = headingLevel === 2 ? "h2" : "h3";
  return (
    <article className={cx(styles.card, compact && styles.cardCompact)}>
      <MemoryCover url={box.coverUrl} onError={onMediaError} />
      <div className={styles.cardBody}>
        <Heading className={styles.cardTitle}>
          <Link to={memoryPath(box.id)} className={styles.cardLink}>
            {box.title}
          </Link>
        </Heading>
        <p className={styles.cardCount}>
          <span aria-hidden="true">📷 </span>
          {mediaCountLabel(box.mediaCount)}
        </p>
        {!compact && box.description !== null ? <p className={styles.cardDescription}>{box.description}</p> : null}
      </div>
    </article>
  );
}
