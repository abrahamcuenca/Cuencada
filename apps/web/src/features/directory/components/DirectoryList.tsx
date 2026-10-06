import type { DirectoryEntry } from "@cuencada/types";
import { type ReactNode, useEffect, useRef } from "react";
import { Link } from "react-router-dom";
import { AvatarCircle } from "../../../shared/ui/AvatarCircle";
import { Button } from "../../../shared/ui/Button";
import { cx } from "../../../shared/ui/cx";
import { Skeleton } from "../../../shared/ui/Skeleton";
import styles from "../directory.module.css";

/** Props for {@link DirectoryList}. */
export interface DirectoryListProps {
  entries: readonly DirectoryEntry[];
  /** The member open in the detail, highlighted in the list. */
  selectedId: string | undefined;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
}

/**
 * Member cards (avatar, name, branch, city when visible), each a link to
 * `/directorio/:userId`. The next page loads when the sentinel nears the
 * viewport, with a "Cargar más" button as the fallback (keyboard and
 * screen-reader users, browsers without IntersectionObserver).
 */
export function DirectoryList({ entries, selectedId, hasMore, loadingMore, onLoadMore }: DirectoryListProps): ReactNode {
  const sentinel = useRef<HTMLDivElement>(null);
  const loadMore = useRef(onLoadMore);
  loadMore.current = onLoadMore;

  useEffect(() => {
    const node = sentinel.current;
    if (!node || !hasMore || loadingMore || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (observed) => {
        if (observed.some((entry) => entry.isIntersecting)) loadMore.current();
      },
      { rootMargin: "400px 0px" }
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasMore, loadingMore]);

  return (
    <>
      <ul className={styles.list} aria-label="Familiares">
        {entries.map((entry) => (
          <li key={entry.userId}>
            <EntryRow entry={entry} selected={entry.userId === selectedId} />
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

function EntryRow({ entry, selected }: { entry: DirectoryEntry; selected: boolean }): ReactNode {
  const name = entry.fullName || entry.displayName;
  const meta = [entry.city, entry.familyBranch].filter((part): part is string => typeof part === "string" && part !== "").join(" · ");
  return (
    <Link to={`/directorio/${entry.userId}`} className={cx(styles.row, selected && styles.rowSelected)} aria-current={selected ? "true" : undefined}>
      <AvatarCircle name={name} src={entry.avatarUrl ?? undefined} size="md" decorative />
      <span className={styles.rowText}>
        <span className={styles.rowName}>{name}</span>
        {meta !== "" ? <span className={styles.rowMeta}>{meta}</span> : null}
      </span>
      <span aria-hidden="true" className={styles.chevron}>
        ›
      </span>
    </Link>
  );
}

/** Placeholder rows while the first page loads. */
export function DirectoryListSkeleton(): ReactNode {
  return (
    <ul className={styles.list} aria-hidden="true">
      {[0, 1, 2, 3, 4, 5].map((index) => (
        <li key={index} className={styles.row}>
          <Skeleton shape="circle" width={48} height={48} />
          <span className={styles.rowText}>
            <Skeleton shape="text" width="60%" />
            <Skeleton shape="text" width="40%" />
          </span>
        </li>
      ))}
    </ul>
  );
}
