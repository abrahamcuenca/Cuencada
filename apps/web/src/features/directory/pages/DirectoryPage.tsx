import { type ReactNode, useId, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { isAbortError } from "../../../shared/api/errors";
import { Button } from "../../../shared/ui/Button";
import { cx } from "../../../shared/ui/cx";
import { EmptyState } from "../../../shared/ui/EmptyState";
import { useExpiredUrlRefetch } from "../../gallery";
import { useListDirectoryInfiniteQuery } from "../api";
import { DirectoryError } from "../components/AccessStates";
import { DirectoryDetail } from "../components/DirectoryDetail";
import { DirectoryList, DirectoryListSkeleton } from "../components/DirectoryList";
import { FiltersSheet } from "../components/FiltersSheet";
import styles from "../directory.module.css";
import {
  type DirectorySheetFilters,
  knownBranches,
  NO_FILTERS,
  SEARCH_DEBOUNCE_MS,
  SEARCH_MIN_CHARS,
  toDirectoryQuery
} from "../lib/filters";
import { useDebouncedValue } from "../lib/useDebouncedValue";

/**
 * `/directorio/:userId?` (members). One route for the list and the detail, so
 * opening a person keeps the search, filters and loaded pages:
 * - phones show either the list or the person (with "‹ Directorio");
 * - from 900px the list sits on the left and the person on the right.
 *
 * Results live only in the in-memory RTK Query cache; nothing is persisted.
 */
export function DirectoryPage(): ReactNode {
  const { userId } = useParams();
  const [search, setSearch] = useState("");
  const [filters, setFilters] = useState<DirectorySheetFilters>(NO_FILTERS);
  const [sheetOpen, setSheetOpen] = useState(false);
  const searchId = useId();
  const searchHintId = useId();

  const debounced = useDebouncedValue(search, SEARCH_DEBOUNCE_MS);
  const query = useMemo(() => toDirectoryQuery(debounced, filters), [debounced, filters]);
  const { data, error, isLoading, isFetching, isFetchingNextPage, hasNextPage, fetchNextPage, refetch } = useListDirectoryInfiniteQuery(query);

  const entries = useMemo(() => data?.pages.flatMap((page) => page.items) ?? [], [data]);
  const branches = useMemo(() => knownBranches(entries), [entries]);
  // Avatar URLs are 1h presigned GETs: when one fails to load, refetch the list once.
  const onImageError = useExpiredUrlRefetch(refetch);

  const activeFilters = (filters.familyBranch !== "" ? 1 : 0) + (filters.city !== "" ? 1 : 0);
  const searching = query.q !== undefined;
  const tooShort = search.trim().length > 0 && search.trim().length < SEARCH_MIN_CHARS;

  const clearAll = (): void => {
    setSearch("");
    setFilters(NO_FILTERS);
  };

  const renderList = (): ReactNode => {
    if (error && !isAbortError(error) && !data) return <DirectoryError error={error} onRetry={() => void refetch()} />;
    if (isLoading || !data) return <DirectoryListSkeleton />;
    if (entries.length === 0 && !hasNextPage) {
      if (searching || activeFilters > 0) {
        return (
          <EmptyState
            icon="🔎"
            title={searching ? `No encontramos a nadie con "${query.q ?? ""}"` : "No encontramos a nadie con esos filtros"}
            description="Revisa la ortografía o quita filtros."
            action={
              <Button variant="secondary" onClick={clearAll}>
                Quitar filtros
              </Button>
            }
          />
        );
      }
      return <EmptyState icon="🧭" title="Todavía no hay nadie en el directorio" description="Cuando la familia complete su perfil, aparecerá aquí." />;
    }
    return (
      <DirectoryList
        entries={entries}
        selectedId={userId}
        hasMore={hasNextPage}
        loadingMore={isFetchingNextPage}
        onLoadMore={() => {
          if (!isFetching) void fetchNextPage();
        }}
      />
    );
  };

  return (
    <div className={cx("cu-container", styles.page, userId !== undefined && styles.hasDetail)}>
      <section className={styles.listPane} aria-labelledby={`${searchId}-title`}>
        <h1 id={`${searchId}-title`} className={styles.title}>
          Directorio familiar
        </h1>
        <div className={styles.searchBar}>
          <label htmlFor={searchId} className="visually-hidden">
            Buscar por nombre o ciudad
          </label>
          <input
            id={searchId}
            type="search"
            inputMode="search"
            enterKeyHint="search"
            autoComplete="off"
            spellCheck={false}
            maxLength={100}
            placeholder="🔎 Buscar familiar"
            aria-describedby={tooShort ? searchHintId : undefined}
            className={styles.searchInput}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <Button variant={activeFilters > 0 ? "primary" : "secondary"} size="sm" icon="⚙️" onClick={() => setSheetOpen(true)}>
            {activeFilters > 0 ? `Filtros (${activeFilters})` : "Filtros"}
          </Button>
        </div>
        <p id={searchHintId} className={styles.searchHint} aria-live="polite">
          {tooShort ? `Escribe al menos ${SEARCH_MIN_CHARS} letras para buscar.` : ""}
        </p>
        {activeFilters > 0 ? (
          <p className={styles.filterSummary}>
            {[filters.familyBranch && `Rama: ${filters.familyBranch}`, filters.city && `Ciudad: ${filters.city}`].filter(Boolean).join(" · ")}{" "}
            <button type="button" className={styles.linkButton} onClick={() => setFilters(NO_FILTERS)}>
              Quitar filtros
            </button>
          </p>
        ) : null}
        <div aria-busy={isFetching && !isFetchingNextPage} onError={onImageError}>
          {renderList()}
        </div>
      </section>

      <section className={styles.detailPane} aria-label="Ficha del familiar">
        {userId !== undefined ? (
          <>
            <Button variant="ghost" size="sm" to="/directorio" icon="‹" className={styles.back}>
              Directorio
            </Button>
            <DirectoryDetail userId={userId} />
          </>
        ) : (
          <p className={styles.detailPlaceholder}>Elige a un familiar para ver su ficha.</p>
        )}
      </section>

      <FiltersSheet
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        value={filters}
        branches={branches}
        onApply={(next) => {
          setFilters(next);
          setSheetOpen(false);
        }}
      />
    </div>
  );
}
