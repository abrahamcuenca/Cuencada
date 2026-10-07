import { createItineraryItemInputSchema, type ItineraryItem, type LocationItem } from "@cuencada/types";
import { type FormEvent, type ReactNode, useState } from "react";
import { formatDate } from "../../../../shared/lib/dates";
import { Badge } from "../../../../shared/ui/Badge";
import { Button } from "../../../../shared/ui/Button";
import { Card } from "../../../../shared/ui/Card";
import { EmptyState } from "../../../../shared/ui/EmptyState";
import { useToast } from "../../../../shared/ui/Toast";
import { formatTimeRange } from "../../lib/format";
import {
  useCreateItineraryItemMutation,
  useDeleteItineraryItemMutation,
  useReorderItineraryMutation,
  useUpdateItineraryItemMutation
} from "../api";
import { blankToNull, type FieldErrors, issuesToFieldErrors, serverErrorToFieldErrors } from "../forms";
import styles from "../admin.module.css";
import { ConfirmDialog, MoveButtons, moveId, toastError } from "./common";
import { FormError, SelectField, TagsField, TextField, VISIBILITY_OPTIONS } from "./fields";

type ItineraryValues = Record<
  "date" | "startTime" | "endTime" | "title" | "description" | "locationName" | "locationId" | "priceNote" | "visibility",
  string
>;

function valuesFrom(item: ItineraryItem | null, defaultDate: string): ItineraryValues {
  return {
    date: item?.date ?? defaultDate,
    startTime: item?.startTime ?? "",
    endTime: item?.endTime ?? "",
    title: item?.title ?? "",
    description: item?.description ?? "",
    locationName: item?.locationName ?? "",
    locationId: item?.locationId ?? "",
    priceNote: item?.priceNote ?? "",
    visibility: item?.visibility ?? "public"
  };
}

/** Itinerary sorted like the public page: by day, then `sortOrder`. */
function sortItinerary(items: readonly ItineraryItem[]): ItineraryItem[] {
  return [...items].sort((a, b) => (a.date === b.date ? a.sortOrder - b.sortOrder : a.date < b.date ? -1 : 1));
}

/** Props for {@link ItineraryEditor}. */
export interface ItineraryEditorProps {
  cuencadaId: string;
  timeZone: string;
  /** First day of the edition (`YYYY-MM-DD`), the default date of a new activity; `""` while the edition has no dates. */
  defaultDate: string;
  items: readonly ItineraryItem[];
  locations: readonly LocationItem[];
}

/**
 * Programa editor: add, edit and delete activities, and reorder them inside
 * their day with ↑/↓ (no drag-and-drop dependency; works with one thumb).
 */
export function ItineraryEditor({ cuencadaId, timeZone, defaultDate, items, locations }: ItineraryEditorProps): ReactNode {
  const toast = useToast();
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [toDelete, setToDelete] = useState<ItineraryItem | null>(null);
  const [reorder, reorderState] = useReorderItineraryMutation();
  const [remove, removeState] = useDeleteItineraryItemMutation();
  const sorted = sortItinerary(items);
  const ids = sorted.map((item) => item.id);

  const move = (index: number, direction: -1 | 1): void => {
    const next = moveId(ids, index, direction);
    if (next === null) return;
    reorder({ cuencadaId, ids: next })
      .unwrap()
      .catch((error: unknown) => toastError(toast, error));
  };

  const confirmDelete = (): void => {
    if (toDelete === null) return;
    remove(toDelete.id)
      .unwrap()
      .then(() => {
        toast.show({ message: "Actividad eliminada.", tone: "success" });
        setToDelete(null);
      })
      .catch((error: unknown) => toastError(toast, error));
  };

  return (
    <div className={styles.editor}>
      <div className={styles.editorHeader}>
        <p className={styles.muted}>{sorted.length === 1 ? "1 actividad" : `${sorted.length} actividades`}</p>
        {editing === "new" ? null : (
          <Button icon="＋" size="sm" onClick={() => setEditing("new")}>
            Agregar actividad
          </Button>
        )}
      </div>
      {editing === "new" ? (
        <ItineraryForm
          cuencadaId={cuencadaId}
          item={null}
          defaultDate={defaultDate}
          locations={locations}
          onDone={() => setEditing(null)}
        />
      ) : null}
      {sorted.length === 0 && editing !== "new" ? (
        <EmptyState icon="📅" headingLevel={3} title="Sin actividades" description="Agrega la primera actividad del programa." />
      ) : (
        <ol className={styles.rows}>
          {sorted.map((item, index) => {
            const previous = sorted[index - 1];
            const next = sorted[index + 1];
            return (
              <li key={item.id}>
                {editing === item.id ? (
                  <ItineraryForm
                    cuencadaId={cuencadaId}
                    item={item}
                    defaultDate={defaultDate}
                    locations={locations}
                    onDone={() => setEditing(null)}
                  />
                ) : (
                  <Card padding="sm" className={styles.row}>
                    <div className={styles.rowMain}>
                      <p className={styles.rowMeta}>
                        {formatDate(item.date, timeZone, { weekday: "short", day: "numeric", month: "short" })}
                        {formatTimeRange(item, timeZone) ? ` · ${formatTimeRange(item, timeZone)}` : ""}
                      </p>
                      <h4 className={styles.rowTitle}>{item.title}</h4>
                      {item.visibility === "members" ? <Badge tone="accent">Solo familia</Badge> : null}
                    </div>
                    <div className={styles.rowActions}>
                      <MoveButtons
                        label={item.title}
                        canMoveUp={previous?.date === item.date}
                        canMoveDown={next?.date === item.date}
                        disabled={reorderState.isLoading}
                        onMove={(direction) => move(index, direction)}
                      />
                      <Button variant="secondary" size="sm" onClick={() => setEditing(item.id)}>
                        Editar
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => setToDelete(item)}>
                        Eliminar
                      </Button>
                    </div>
                  </Card>
                )}
              </li>
            );
          })}
        </ol>
      )}
      <ConfirmDialog
        open={toDelete !== null}
        title="¿Eliminar esta actividad?"
        description={toDelete ? `«${toDelete.title}» desaparecerá del programa.` : ""}
        confirmLabel="Eliminar"
        busy={removeState.isLoading}
        onConfirm={confirmDelete}
        onClose={() => setToDelete(null)}
      />
    </div>
  );
}

interface ItineraryFormProps {
  cuencadaId: string;
  item: ItineraryItem | null;
  defaultDate: string;
  locations: readonly LocationItem[];
  onDone: () => void;
}

function ItineraryForm({ cuencadaId, item, defaultDate, locations, onDone }: ItineraryFormProps): ReactNode {
  const toast = useToast();
  const [values, setValues] = useState(() => valuesFrom(item, defaultDate));
  const [tags, setTags] = useState<string[]>(() => [...(item?.tags ?? [])]);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [create, createState] = useCreateItineraryItemMutation();
  const [update, updateState] = useUpdateItineraryItemMutation();
  const onChange = (name: string, value: string): void => setValues((current) => ({ ...current, [name]: value }));

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const location = locations.find((candidate) => candidate.id === values.locationId);
    const parsed = createItineraryItemInputSchema.safeParse({
      date: values.date,
      startTime: blankToNull(values.startTime),
      endTime: blankToNull(values.endTime),
      title: values.title,
      description: values.description,
      // A linked location fills in the name when none was typed.
      locationName: blankToNull(values.locationName) ?? location?.name ?? null,
      locationId: blankToNull(values.locationId),
      priceNote: values.priceNote,
      tags,
      visibility: values.visibility
    });
    // Also a schema refine, but zod skips object refines while any field is invalid.
    const rangeErrors: FieldErrors =
      values.startTime && values.endTime && values.endTime <= values.startTime ? { endTime: "La hora de fin debe ser posterior a la de inicio." } : {};
    if (!parsed.success || Object.keys(rangeErrors).length > 0) {
      setErrors({ ...(parsed.success ? {} : issuesToFieldErrors(parsed.error.issues)), ...rangeErrors });
      return;
    }
    setErrors({});
    const request = item ? update({ id: item.id, patch: parsed.data }) : create({ cuencadaId, body: parsed.data });
    request
      .unwrap()
      .then(() => {
        toast.show({ message: item ? "Cambios guardados." : "Actividad agregada.", tone: "success" });
        onDone();
      })
      .catch((error: unknown) => setErrors(serverErrorToFieldErrors(error, "No pudimos guardar la actividad. Inténtalo otra vez.")));
  };

  const bind = (name: keyof ItineraryValues): { name: string; value: string; errors: FieldErrors; onChange: typeof onChange } => ({
    name,
    value: values[name],
    errors,
    onChange
  });

  return (
    <Card padding="sm">
      <form noValidate onSubmit={submit} className={styles.form} aria-label={item ? `Editar «${item.title}»` : "Nueva actividad"}>
        <FormError errors={errors} />
        <TextField {...bind("title")} label="Título" required maxLength={200} />
        <div className={styles.grid3}>
          <TextField {...bind("date")} label="Día" required type="date" />
          <TextField {...bind("startTime")} label="Inicio" type="time" />
          <TextField {...bind("endTime")} label="Fin" type="time" />
        </div>
        <TextField {...bind("description")} label="Descripción" multiline maxLength={2000} />
        <div className={styles.grid2}>
          <SelectField
            {...bind("locationId")}
            label="Lugar vinculado"
            options={[{ value: "", label: "Ninguno" }, ...locations.map((location) => ({ value: location.id, label: location.name }))]}
          />
          <TextField {...bind("locationName")} label="Nombre del lugar" maxLength={200} hint="Si lo dejas vacío, se usa el lugar vinculado." />
        </div>
        <TagsField name="tags" label="Etiquetas" tags={tags} onChange={setTags} errors={errors} />
        <div className={styles.grid2}>
          <TextField {...bind("priceNote")} label="Precio" maxLength={120} hint="Texto libre, por ejemplo $1,000 p/p." />
          <SelectField {...bind("visibility")} label="¿Quién lo ve?" options={VISIBILITY_OPTIONS} />
        </div>
        <div className={styles.formActions}>
          <Button variant="secondary" onClick={onDone}>
            Cancelar
          </Button>
          <Button type="submit" loading={createState.isLoading || updateState.isLoading}>
            {item ? "Guardar cambios" : "Agregar actividad"}
          </Button>
        </div>
      </form>
    </Card>
  );
}
