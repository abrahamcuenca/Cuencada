import { type FormEvent, type ReactNode, useId, useState } from "react";
import { Button } from "../../../shared/ui/Button";
import { Dialog } from "../../../shared/ui/Dialog";
import { Field } from "../../../shared/ui/Field";
import { TextInput } from "../../../shared/ui/TextInput";
import type { DirectoryEntry } from "@cuencada/types";
import { citySuggestions, type DirectorySheetFilters, NO_FILTERS } from "../lib/filters";
import styles from "../directory.module.css";

/** Props for {@link FiltersSheet}. */
export interface FiltersSheetProps {
  open: boolean;
  onClose: () => void;
  value: DirectorySheetFilters;
  onApply: (filters: DirectorySheetFilters) => void;
  /** Branch suggestions (from the rows seen so far; memory only). */
  branches: readonly string[];
  /** Loaded rows, for city prefix suggestions (memory only). */
  entries: readonly DirectoryEntry[];
}

/**
 * "Filtros" bottom sheet (a centred card from 600px): family branch and city.
 * Edits are a draft until "Ver resultados".
 */
export function FiltersSheet({ open, onClose, value, onApply, branches, entries }: FiltersSheetProps): ReactNode {
  return (
    <Dialog open={open} onClose={onClose} title="Filtros" description="Encuentra a tu familia por rama o por ciudad.">
      {/* Remount on open so the draft starts from the applied filters. */}
      {open ? <FiltersForm value={value} onApply={onApply} branches={branches} entries={entries} /> : null}
    </Dialog>
  );
}

function FiltersForm({ value, onApply, branches, entries }: Omit<FiltersSheetProps, "open" | "onClose">): ReactNode {
  const [draft, setDraft] = useState(value);
  const listId = useId();
  const cityListId = useId();
  const cities = citySuggestions(entries, draft.city);

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    onApply({ familyBranch: draft.familyBranch.trim(), city: draft.city.trim() });
  };

  return (
    <form className={styles.filtersForm} noValidate onSubmit={onSubmit}>
      <Field label="Rama familiar" hint="Por ejemplo: Rama Norte.">
        {(control) => (
          <TextInput
            {...control}
            list={branches.length > 0 ? listId : undefined}
            autoComplete="off"
            enterKeyHint="search"
            maxLength={120}
            value={draft.familyBranch}
            onChange={(event) => setDraft((current) => ({ ...current, familyBranch: event.target.value }))}
          />
        )}
      </Field>
      {branches.length > 0 ? (
        <datalist id={listId}>
          {branches.map((branch) => (
            <option key={branch} value={branch} />
          ))}
        </datalist>
      ) : null}
      <Field label="Ciudad" hint="Solo aparecen quienes muestran su ciudad.">
        {(control) => (
          <TextInput
            {...control}
            list={cities.length > 0 ? cityListId : undefined}
            autoComplete="off"
            enterKeyHint="search"
            maxLength={120}
            value={draft.city}
            onChange={(event) => setDraft((current) => ({ ...current, city: event.target.value }))}
          />
        )}
      </Field>
      {cities.length > 0 ? (
        <datalist id={cityListId} data-testid="city-suggestions">
          {cities.map((city) => (
            <option key={city} value={city} />
          ))}
        </datalist>
      ) : null}
      <div className={styles.filtersActions}>
        <Button type="submit" fullWidth>
          Ver resultados
        </Button>
        <Button variant="ghost" fullWidth onClick={() => onApply(NO_FILTERS)}>
          Quitar filtros
        </Button>
      </div>
    </form>
  );
}
