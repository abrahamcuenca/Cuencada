import type { PersonSummary } from "@cuencada/types";
import { type ReactNode, useId, useState } from "react";
import { AvatarCircle } from "../../../shared/ui/AvatarCircle";
import { Spinner } from "../../../shared/ui/Spinner";
import { TextInput } from "../../../shared/ui/TextInput";
import { cx } from "../../../shared/ui/cx";
import { useSearchPeopleQuery } from "../api";
import styles from "../family.module.css";
import { useDebouncedValue } from "../lib/hooks";
import { displayName } from "../lib/tree";

/** Shortest query sent to the server. */
export const SEARCH_MIN_CHARS = 2;
const SEARCH_LIMIT = 8;

/** Props for {@link PersonSearch}. */
export interface PersonSearchProps {
  /** Visible label of the search box. */
  label: string;
  /** Called with the chosen person. */
  onPick: (person: PersonSummary) => void;
  /** People that cannot be picked (shown disabled with `excludedReason`). */
  excludeIds?: ReadonlySet<string>;
  excludedReason?: string;
  /** Verb on each result's accessible name, e.g. "Ver a" or "Elegir a". */
  actionLabel?: string;
  autoFocus?: boolean;
  /** Empty the box after a pick (default). Pickers that may show an error keep the query. */
  clearOnPick?: boolean;
  className?: string | undefined;
}

/**
 * Debounced people search (`GET /family/people?q=`) with a list of result
 * buttons. Nothing is requested until {@link SEARCH_MIN_CHARS} characters.
 * Result counts are announced through a polite live region.
 */
export function PersonSearch({
  label,
  onPick,
  excludeIds,
  excludedReason = "Ya está relacionada",
  actionLabel = "Ver a",
  autoFocus = false,
  clearOnPick = true,
  className
}: PersonSearchProps): ReactNode {
  const [text, setText] = useState("");
  const q = useDebouncedValue(text.trim());
  const inputId = useId();
  const statusId = useId();
  const enabled = q.length >= SEARCH_MIN_CHARS;
  const result = useSearchPeopleQuery({ q, limit: SEARCH_LIMIT }, { skip: !enabled });
  const items = enabled ? (result.currentData?.items ?? []) : [];
  const pending = enabled && (result.isFetching || (result.currentData === undefined && result.error === undefined));

  let status = "";
  if (enabled && !pending) {
    if (result.error !== undefined) status = "No pudimos buscar. Inténtalo otra vez.";
    else if (items.length === 0) status = `No encontramos a nadie con «${q}».`;
    else status = items.length === 1 ? "1 resultado." : `${items.length} resultados.`;
  }

  return (
    <div className={cx(styles.search, className)}>
      <label htmlFor={inputId} className={styles.searchLabel}>
        {label}
      </label>
      <TextInput
        id={inputId}
        type="search"
        value={text}
        placeholder="Nombre o apodo"
        autoComplete="off"
        enterKeyHint="search"
        maxLength={100}
        autoFocus={autoFocus}
        aria-describedby={statusId}
        onChange={(event) => setText(event.target.value)}
      />
      <p id={statusId} className={styles.searchStatus} aria-live="polite">
        {pending ? (
          <>
            <Spinner size="inline" decorative /> Buscando…
          </>
        ) : (
          status
        )}
      </p>
      {items.length > 0 ? (
        <ul className={styles.searchResults} aria-label="Resultados">
          {items.map((person) => {
            const excluded = excludeIds?.has(person.id) ?? false;
            return (
              <li key={person.id}>
                <button
                  type="button"
                  className={styles.searchResult}
                  disabled={excluded}
                  aria-label={`${actionLabel} ${person.fullName}${person.deceased ? ", ya falleció" : ""}${excluded ? ` (${excludedReason})` : ""}`}
                  onClick={() => {
                    onPick(person);
                    if (clearOnPick) setText("");
                  }}
                >
                  <AvatarCircle name={person.fullName} src={person.avatarUrl ?? undefined} size="sm" decorative />
                  <span className={styles.searchResultName}>
                    {displayName(person)}
                    {person.deceased ? <span className={styles.dagger}> †</span> : null}
                  </span>
                  {excluded ? <span className={styles.searchResultNote}>{excludedReason}</span> : null}
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
