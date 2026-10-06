import type { AttendanceRecord, PersonSummary } from "@cuencada/types";
import { type ReactNode, useEffect, useState } from "react";
import { getApiErrorMessage, isAbortError } from "../../../shared/api/errors";
import { Button } from "../../../shared/ui/Button";
import { Checkbox } from "../../../shared/ui/Checkbox";
import { Field } from "../../../shared/ui/Field";
import { Skeleton } from "../../../shared/ui/Skeleton";
import { TextInput } from "../../../shared/ui/TextInput";
import { useToast } from "../../../shared/ui/Toast";
import { useGetAdminAttendanceQuery, useListAttendancePeopleQuery, useSaveAdminAttendanceMutation } from "../api";
import { type AttendanceChanges, attendanceChanges, checklistRows, matchesSearch, toggleAttendance } from "./attendanceModel";
import styles from "./admin.module.css";

/** People per request; the API caps pages at 100. */
const PEOPLE_PAGE_SIZE = 100;
const SEARCH_DEBOUNCE_MS = 300;

/** Delays a fast-changing value (search box) so we don't request on every key. */
function useDebounced<TValue>(value: TValue, delayMs: number): TValue {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const handle = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(handle);
  }, [value, delayMs]);
  return debounced;
}

/** Props for {@link AttendanceChecklist}. */
export interface AttendanceChecklistProps {
  cuencadaId: string;
}

/**
 * Searchable list of family people with a checkbox each. Changes are kept
 * locally and saved in one bulk request (`add` / `remove`) from the sticky bar.
 */
export function AttendanceChecklist({ cuencadaId }: AttendanceChecklistProps): ReactNode {
  const toast = useToast();
  const attendance = useGetAdminAttendanceQuery(cuencadaId);
  const [search, setSearch] = useState("");
  const q = useDebounced(search.trim(), SEARCH_DEBOUNCE_MS);
  const people = useListAttendancePeopleQuery(q === "" ? { limit: PEOPLE_PAGE_SIZE } : { q, limit: PEOPLE_PAGE_SIZE });
  const [changes, setChanges] = useState<AttendanceChanges>({ add: new Set(), remove: new Set() });
  const [save, saveState] = useSaveAdminAttendanceMutation();

  if (attendance.data === undefined) {
    if (attendance.error !== undefined && !isAbortError(attendance.error)) {
      return (
        <div className={styles.panel}>
          <p className={styles.formError}>No pudimos cargar la asistencia.</p>
          <Button variant="secondary" onClick={() => void attendance.refetch()}>
            Reintentar
          </Button>
        </div>
      );
    }
    return <Skeleton shape="block" height="12rem" />;
  }

  const records: readonly AttendanceRecord[] = attendance.data;
  const recorded = new Set(records.map((record) => record.personId));
  const peopleItems: readonly PersonSummary[] = people.data?.items ?? [];
  const rows = checklistRows(
    records.filter((record) => matchesSearch(record.displayName, q)),
    peopleItems
  );
  const { add, remove } = attendanceChanges(changes);
  const pending = add.length + remove.length;
  const total = recorded.size - remove.length + add.length;
  const isChecked = (personId: string): boolean => (recorded.has(personId) ? !changes.remove.has(personId) : changes.add.has(personId));

  const onSave = (): void => {
    save({ cuencadaId, body: { add, remove } })
      .unwrap()
      .then(() => {
        setChanges({ add: new Set(), remove: new Set() });
        toast.show({ message: "Asistencia guardada.", tone: "success" });
      })
      .catch((error: unknown) => {
        if (!isAbortError(error)) toast.show({ message: getApiErrorMessage(error), tone: "danger" });
      });
  };

  return (
    <div className={styles.panel}>
      <p className={styles.muted}>
        Marca a quienes asistieron. Incluye a familiares sin cuenta; se guardan todos los cambios juntos.
      </p>
      <Field label="Buscar persona">
        {(control) => (
          <TextInput
            {...control}
            type="search"
            inputMode="search"
            autoComplete="off"
            placeholder="Nombre o apodo"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        )}
      </Field>

      {people.error !== undefined && !isAbortError(people.error) ? (
        <p className={styles.formError} role="alert">
          No pudimos cargar la lista de personas de la familia. Puedes quitar a quienes ya están registrados.
        </p>
      ) : null}

      {rows.length === 0 ? (
        people.isFetching ? (
          <Skeleton lines={4} />
        ) : (
          <p className={styles.muted}>{q === "" ? "Todavía no hay personas en el árbol familiar." : `Nadie coincide con «${q}».`}</p>
        )
      ) : (
        <ul className={styles.checklist} aria-label="Personas" aria-busy={people.isFetching || undefined}>
          {rows.map((row) => (
            <li key={row.personId}>
              <Checkbox
                label={row.label}
                hint={row.hint}
                checked={isChecked(row.personId)}
                onChange={(event) =>
                  setChanges((current) => toggleAttendance(current, row.personId, event.target.checked, recorded.has(row.personId)))
                }
              />
            </li>
          ))}
        </ul>
      )}
      {people.data?.nextCursor ? <p className={styles.muted}>Hay más personas: usa la búsqueda para encontrarlas.</p> : null}

      <div className={styles.saveBar}>
        <p className={styles.saveBarText} aria-live="polite">
          {total} {total === 1 ? "asistente" : "asistentes"}
          {pending > 0 ? ` · ${pending} ${pending === 1 ? "cambio" : "cambios"} sin guardar` : ""}
        </p>
        <Button disabled={pending === 0} loading={saveState.isLoading} onClick={onSave}>
          Guardar asistencia
        </Button>
      </div>
    </div>
  );
}
