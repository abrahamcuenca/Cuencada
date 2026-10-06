import { createLocationInputSchema, type LocationItem, LocationKind } from "@cuencada/types";
import { type FormEvent, type ReactNode, useState } from "react";
import { Badge } from "../../../../shared/ui/Badge";
import { Button } from "../../../../shared/ui/Button";
import { Card } from "../../../../shared/ui/Card";
import { EmptyState } from "../../../../shared/ui/EmptyState";
import type { SelectOption } from "../../../../shared/ui/Select";
import { useToast } from "../../../../shared/ui/Toast";
import { useCreateLocationMutation, useDeleteLocationMutation, useReorderLocationsMutation, useUpdateLocationMutation } from "../api";
import { blankToNull, type FieldErrors, issuesToFieldErrors, serverErrorToFieldErrors } from "../forms";
import styles from "../admin.module.css";
import { ConfirmDialog, MoveButtons, moveId, toastError } from "./common";
import { FormError, SelectField, TextField, VISIBILITY_OPTIONS } from "./fields";

const KIND_OPTIONS: readonly SelectOption[] = [
  { value: LocationKind.Hotel, label: "🏨 Hotel" },
  { value: LocationKind.Venue, label: "🎉 Sede" },
  { value: LocationKind.Attraction, label: "🌴 Atracción" },
  { value: LocationKind.Other, label: "📍 Otro" }
];

type LocationValues = Record<"name" | "kind" | "description" | "address" | "url" | "mapsUrl" | "lat" | "lng" | "visibility", string>;

function valuesFrom(location: LocationItem | null): LocationValues {
  return {
    name: location?.name ?? "",
    kind: location?.kind ?? LocationKind.Hotel,
    description: location?.description ?? "",
    address: location?.address ?? "",
    url: location?.url ?? "",
    mapsUrl: location?.mapsUrl ?? "",
    lat: location?.lat === null || location?.lat === undefined ? "" : String(location.lat),
    lng: location?.lng === null || location?.lng === undefined ? "" : String(location.lng),
    visibility: location?.visibility ?? "public"
  };
}

/**
 * Parses an optional coordinate typed by an admin.
 *
 * @returns The number, `null` when blank, or an error message.
 */
function parseCoordinate(raw: string, limit: number): number | null | string {
  const value = raw.trim().replace(",", ".");
  if (value === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number) || Math.abs(number) > limit) return `Escribe un número entre -${limit} y ${limit}.`;
  return number;
}

/** Props for {@link LocationEditor}. */
export interface LocationEditorProps {
  cuencadaId: string;
  locations: readonly LocationItem[];
}

/** "¿Dónde estamos?" editor: hotels, venues and attractions, reordered with ↑/↓. */
export function LocationEditor({ cuencadaId, locations }: LocationEditorProps): ReactNode {
  const toast = useToast();
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [toDelete, setToDelete] = useState<LocationItem | null>(null);
  const [reorder, reorderState] = useReorderLocationsMutation();
  const [remove, removeState] = useDeleteLocationMutation();
  const sorted = [...locations].sort((a, b) => a.sortOrder - b.sortOrder);
  const ids = sorted.map((location) => location.id);

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
        toast.show({ message: "Lugar eliminado.", tone: "success" });
        setToDelete(null);
      })
      .catch((error: unknown) => toastError(toast, error));
  };

  return (
    <div className={styles.editor}>
      <div className={styles.editorHeader}>
        <p className={styles.muted}>{sorted.length === 1 ? "1 lugar" : `${sorted.length} lugares`}</p>
        {editing === "new" ? null : (
          <Button icon="＋" size="sm" onClick={() => setEditing("new")}>
            Agregar lugar
          </Button>
        )}
      </div>
      {editing === "new" ? <LocationForm cuencadaId={cuencadaId} location={null} onDone={() => setEditing(null)} /> : null}
      {sorted.length === 0 && editing !== "new" ? (
        <EmptyState icon="🗺️" headingLevel={3} title="Sin lugares" description="Agrega los hoteles y sedes de esta Cuencada." />
      ) : (
        <ol className={styles.rows}>
          {sorted.map((location, index) => (
            <li key={location.id}>
              {editing === location.id ? (
                <LocationForm cuencadaId={cuencadaId} location={location} onDone={() => setEditing(null)} />
              ) : (
                <Card padding="sm" className={styles.row}>
                  <div className={styles.rowMain}>
                    <p className={styles.rowMeta}>{KIND_OPTIONS.find((option) => option.value === location.kind)?.label}</p>
                    <h4 className={styles.rowTitle}>{location.name}</h4>
                    {location.visibility === "members" ? <Badge tone="accent">Solo familia</Badge> : null}
                  </div>
                  <div className={styles.rowActions}>
                    <MoveButtons
                      label={location.name}
                      canMoveUp={index > 0}
                      canMoveDown={index < sorted.length - 1}
                      disabled={reorderState.isLoading}
                      onMove={(direction) => move(index, direction)}
                    />
                    <Button variant="secondary" size="sm" onClick={() => setEditing(location.id)}>
                      Editar
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setToDelete(location)}>
                      Eliminar
                    </Button>
                  </div>
                </Card>
              )}
            </li>
          ))}
        </ol>
      )}
      <ConfirmDialog
        open={toDelete !== null}
        title="¿Eliminar este lugar?"
        description={toDelete ? `«${toDelete.name}» desaparecerá de la lista. Las actividades vinculadas conservan su texto.` : ""}
        confirmLabel="Eliminar"
        busy={removeState.isLoading}
        onConfirm={confirmDelete}
        onClose={() => setToDelete(null)}
      />
    </div>
  );
}

function LocationForm({ cuencadaId, location, onDone }: { cuencadaId: string; location: LocationItem | null; onDone: () => void }): ReactNode {
  const toast = useToast();
  const [values, setValues] = useState(() => valuesFrom(location));
  const [errors, setErrors] = useState<FieldErrors>({});
  const [create, createState] = useCreateLocationMutation();
  const [update, updateState] = useUpdateLocationMutation();
  const onChange = (name: string, value: string): void => setValues((current) => ({ ...current, [name]: value }));

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const lat = parseCoordinate(values.lat, 90);
    const lng = parseCoordinate(values.lng, 180);
    const coordinateErrors: FieldErrors = {};
    if (typeof lat === "string") coordinateErrors.lat = lat;
    if (typeof lng === "string") coordinateErrors.lng = lng;
    // Also a schema refine, but zod skips object refines while any field is invalid.
    if (typeof lat !== "string" && typeof lng !== "string" && (lat === null) !== (lng === null)) coordinateErrors.lng = "Latitud y longitud van juntas.";
    const parsed = createLocationInputSchema.safeParse({
      name: values.name,
      kind: values.kind,
      description: values.description,
      address: values.address,
      url: blankToNull(values.url),
      mapsUrl: blankToNull(values.mapsUrl),
      lat: typeof lat === "string" ? null : lat,
      lng: typeof lng === "string" ? null : lng,
      visibility: values.visibility
    });
    if (!parsed.success || Object.keys(coordinateErrors).length > 0) {
      setErrors({ ...(parsed.success ? {} : issuesToFieldErrors(parsed.error.issues)), ...coordinateErrors });
      return;
    }
    setErrors({});
    const request = location ? update({ id: location.id, patch: parsed.data }) : create({ cuencadaId, body: parsed.data });
    request
      .unwrap()
      .then(() => {
        toast.show({ message: location ? "Cambios guardados." : "Lugar agregado.", tone: "success" });
        onDone();
      })
      .catch((error: unknown) => setErrors(serverErrorToFieldErrors(error, "No pudimos guardar el lugar. Inténtalo otra vez.")));
  };

  const bind = (name: keyof LocationValues): { name: string; value: string; errors: FieldErrors; onChange: typeof onChange } => ({
    name,
    value: values[name],
    errors,
    onChange
  });

  return (
    <Card padding="sm">
      <form noValidate onSubmit={submit} className={styles.form} aria-label={location ? `Editar «${location.name}»` : "Nuevo lugar"}>
        <FormError errors={errors} />
        <div className={styles.grid2}>
          <TextField {...bind("name")} label="Nombre" required maxLength={200} />
          <SelectField {...bind("kind")} label="Tipo" options={KIND_OPTIONS} />
        </div>
        <TextField {...bind("description")} label="Descripción" multiline maxLength={2000} />
        <TextField {...bind("address")} label="Dirección" maxLength={300} autoComplete="street-address" />
        <TextField {...bind("mapsUrl")} label="Enlace de Google Maps" type="url" inputMode="url" />
        <TextField {...bind("url")} label="Sitio web" type="url" inputMode="url" hint="Página del hotel o del lugar." />
        <div className={styles.grid2}>
          <TextField {...bind("lat")} label="Latitud" inputMode="decimal" hint="Junto con la longitud." />
          <TextField {...bind("lng")} label="Longitud" inputMode="decimal" />
        </div>
        <SelectField {...bind("visibility")} label="¿Quién lo ve?" options={VISIBILITY_OPTIONS} />
        <div className={styles.formActions}>
          <Button variant="secondary" onClick={onDone}>
            Cancelar
          </Button>
          <Button type="submit" loading={createState.isLoading || updateState.isLoading}>
            {location ? "Guardar cambios" : "Agregar lugar"}
          </Button>
        </div>
      </form>
    </Card>
  );
}
