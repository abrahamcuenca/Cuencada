/**
 * Create / edit an event (WP-5.4), in a sheet. Members never type a slug: the
 * form previews the address the title gives plus the short random code the
 * server adds (Security M1). Admins get an editable slug and use the admin
 * endpoints. Dates are optional ("Por anunciar"); both or neither.
 */
import { EVENT_DETAILS_MAX_LENGTH, EVENT_LOCATION_MAX_LENGTH, EVENT_SUMMARY_MAX_LENGTH, EVENT_TITLE_MAX_LENGTH, type EventDetail } from "@cuencada/types";
import { type FormEvent, type ReactNode, useId, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAppSelector } from "../../../app/hooks";
import { isAbortError } from "../../../shared/api/errors";
import { Button } from "../../../shared/ui/Button";
import { Switch } from "../../../shared/ui/Checkbox";
import { Dialog } from "../../../shared/ui/Dialog";
import { Field } from "../../../shared/ui/Field";
import { Select } from "../../../shared/ui/Select";
import { TextArea } from "../../../shared/ui/TextArea";
import { TextInput } from "../../../shared/ui/TextInput";
import { useToast } from "../../../shared/ui/Toast";
import { cx } from "../../../shared/ui/cx";
import { selectIsAdmin } from "../../auth/authSlice";
import { type FieldErrors, serverErrorToFieldErrors } from "../../cuencadas/admin/forms";
import { useAdminCreateEventMutation, useAdminUpdateEventMutation, useCreateEventMutation, useUpdateEventMutation } from "../api";
import styles from "../events.module.css";
import { type EventFormValues, initialFormValues, previewYear, toCreateRequest, toUpdateRequest, yearOptions } from "../lib/form";
import { eventErrorMessage, eventIssueCode, eventPath, SLUG_CODE_NOTE, slugPreview } from "../lib/format";

/** Help text of the two visibility options. */
export const VISIBILITY_HELP = {
  members: "Cualquier miembro de la familia lo ve y puede apuntarse.",
  participants: "Solo lo ven las personas que agregues (y los administradores). Les avisaremos cuando las agregues."
} as const;

/** Props for {@link EventFormSheet}. */
export interface EventFormSheetProps {
  open: boolean;
  onClose: () => void;
  /** The event to edit; omit to create one. */
  event?: EventDetail;
}

/** The create/edit sheet. Mount it while open (`key` it per event) so the form starts fresh. */
export function EventFormSheet({ open, onClose, event }: EventFormSheetProps): ReactNode {
  const formId = useId();
  const isAdmin = useAppSelector(selectIsAdmin);
  const navigate = useNavigate();
  const toast = useToast();
  const [values, setValues] = useState<EventFormValues>(() => initialFormValues(event));
  const [errors, setErrors] = useState<FieldErrors>({});
  const [create, createState] = useCreateEventMutation();
  const [adminCreate, adminCreateState] = useAdminCreateEventMutation();
  const [update, updateState] = useUpdateEventMutation();
  const [adminUpdate, adminUpdateState] = useAdminUpdateEventMutation();
  const saving = createState.isLoading || adminCreateState.isLoading || updateState.isLoading || adminUpdateState.isLoading;
  const editing = event !== undefined;

  const set = <TKey extends keyof EventFormValues>(key: TKey, value: EventFormValues[TKey]): void => {
    setValues((current) => ({ ...current, [key]: value }));
    setErrors((current) => (current[key] === undefined ? current : { ...current, [key]: undefined }));
  };

  const onSaved = (saved: EventDetail): void => {
    toast.show({ message: editing ? "Cambios guardados." : "Evento creado.", tone: "success" });
    onClose();
    // A new event, or a changed start year / admin slug, lives at a new address.
    if (!editing || saved.year !== event.year || saved.slug !== event.slug) navigate(eventPath(saved), { replace: editing });
  };

  const onFailed = (failure: unknown): void => {
    if (isAbortError(failure)) return;
    const fieldErrors = serverErrorToFieldErrors(failure, eventErrorMessage(failure));
    if (eventIssueCode(failure) === "EVENT_SLUG_TAKEN") fieldErrors.slug = eventErrorMessage(failure);
    setErrors({ ...fieldErrors, _form: eventErrorMessage(failure) });
  };

  const submit = async (submitEvent: FormEvent<HTMLFormElement>): Promise<void> => {
    submitEvent.preventDefault();
    if (saving) return;
    if (!editing) {
      const result = toCreateRequest(values, isAdmin);
      if (!result.ok) {
        setErrors(result.errors);
        return;
      }
      try {
        onSaved(await (isAdmin ? adminCreate(result.request) : create(result.request)).unwrap());
      } catch (failure) {
        onFailed(failure);
      }
      return;
    }
    const result = toUpdateRequest(values, event, isAdmin);
    if (result === null) {
      onClose();
      return;
    }
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    try {
      onSaved(await (isAdmin ? adminUpdate({ id: event.id, body: result.request }) : update({ id: event.id, body: result.request })).unwrap());
    } catch (failure) {
      onFailed(failure);
    }
  };

  const years = yearOptions(new Date(), editing ? event.year : undefined);
  const summaryLength = values.summary.trim().length;
  const hidden = event?.status === "hidden";

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={editing ? "Editar evento" : "Crear evento"}
      closeOnBackdrop={false}
      className={styles.sheet}
      footer={
        <>
          <Button variant="secondary" fullWidth onClick={onClose} disabled={saving}>
            Cancelar
          </Button>
          <Button type="submit" form={formId} fullWidth loading={saving}>
            {editing ? "Guardar cambios" : "Crear evento"}
          </Button>
        </>
      }
    >
      <form id={formId} noValidate aria-label={editing ? "Editar evento" : "Crear evento"} className={styles.form} onSubmit={(e) => void submit(e)}>
        {errors._form !== undefined ? (
          <p className={styles.formError} role="alert">
            <span aria-hidden="true">⚠️ </span>
            {errors._form}
          </p>
        ) : null}
        <Field label="Título" required error={errors.title}>
          {(p) => (
            <TextInput
              {...p}
              autoComplete="off"
              enterKeyHint="next"
              maxLength={EVENT_TITLE_MAX_LENGTH}
              value={values.title}
              onChange={(e) => set("title", e.target.value)}
            />
          )}
        </Field>
        <SlugField values={values} editing={editing} event={event} isAdmin={isAdmin} error={errors.slug} onChange={(slug) => set("slug", slug)} />
        <Field
          label="Resumen"
          showOptional
          hint={
            <span className={cx(styles.counter, summaryLength > EVENT_SUMMARY_MAX_LENGTH && styles.counterOver)}>
              Una o dos líneas para la tarjeta. {summaryLength}/{EVENT_SUMMARY_MAX_LENGTH}
            </span>
          }
          error={errors.summary}
        >
          {(p) => <TextArea {...p} rows={2} value={values.summary} onChange={(e) => set("summary", e.target.value)} />}
        </Field>
        <Field label="Detalles" showOptional hint="Qué llevar, cómo llegar, horarios…" error={errors.details}>
          {(p) => <TextArea {...p} rows={5} maxLength={EVENT_DETAILS_MAX_LENGTH} value={values.details} onChange={(e) => set("details", e.target.value)} />}
        </Field>

        <fieldset className={styles.fieldset}>
          <legend className={styles.legend}>Fechas</legend>
          <Switch
            label="Ya tenemos fecha"
            hint={values.dated ? "Hora de Mérida. Escribe el inicio y el fin." : "Por ahora se mostrará «Por anunciar»."}
            checked={values.dated}
            onChange={(e) => set("dated", e.target.checked)}
          />
          {values.dated ? (
            <div className={styles.dateRow}>
              <Field label="Inicio" required error={errors.startsAt}>
                {(p) => <TextInput {...p} type="datetime-local" value={values.startsAt} onChange={(e) => set("startsAt", e.target.value)} />}
              </Field>
              <Field label="Fin" required error={errors.endsAt}>
                {(p) => <TextInput {...p} type="datetime-local" value={values.endsAt} onChange={(e) => set("endsAt", e.target.value)} />}
              </Field>
            </div>
          ) : (
            <Field label="Año" required error={errors.year}>
              {(p) => (
                <Select {...p} value={values.year} options={years.map((year) => ({ value: String(year), label: String(year) }))} onChange={(e) => set("year", e.target.value)} />
              )}
            </Field>
          )}
          {values.dated && errors.year !== undefined ? <p className={styles.fieldError}>{errors.year}</p> : null}
        </fieldset>

        <Field label="Lugar" showOptional hint="Por ejemplo: Casa de la tía Rosa, Pueblo Ejemplo." error={errors.locationText}>
          {(p) => (
            <TextInput
              {...p}
              autoComplete="off"
              maxLength={EVENT_LOCATION_MAX_LENGTH}
              value={values.locationText}
              onChange={(e) => set("locationText", e.target.value)}
            />
          )}
        </Field>

        <fieldset className={styles.fieldset}>
          <legend className={styles.legend}>¿Quién puede verlo?</legend>
          <VisibilityOption value="members" label="Todos los miembros" checked={values.visibility === "members"} onChange={() => set("visibility", "members")} />
          <VisibilityOption
            value="participants"
            label="Solo participantes"
            checked={values.visibility === "participants"}
            onChange={() => set("visibility", "participants")}
          />
          {errors.visibility !== undefined ? <p className={styles.fieldError}>{errors.visibility}</p> : null}
        </fieldset>

        {hidden ? (
          <p className={styles.note}>Este evento está oculto. Solo un administrador puede volver a mostrarlo.</p>
        ) : (
          <Switch
            label={editing ? "Publicado" : "Publicar ahora"}
            hint="Si no lo publicas, queda como borrador: solo lo ven quienes lo organizan y los administradores."
            checked={values.published}
            onChange={(e) => set("published", e.target.checked)}
          />
        )}
      </form>
    </Dialog>
  );
}

function VisibilityOption({ value, label, checked, onChange }: { value: "members" | "participants"; label: string; checked: boolean; onChange: () => void }): ReactNode {
  const id = useId();
  return (
    <div className={styles.radioRow}>
      <input id={id} type="radio" name="event-visibility" value={value} checked={checked} onChange={onChange} className={styles.radio} aria-describedby={`${id}-help`} />
      <div>
        <label htmlFor={id} className={styles.radioLabel}>
          {label}
        </label>
        <p id={`${id}-help`} className={styles.radioHelp}>
          {VISIBILITY_HELP[value]}
        </p>
      </div>
    </div>
  );
}

interface SlugFieldProps {
  values: EventFormValues;
  editing: boolean;
  event: EventDetail | undefined;
  isAdmin: boolean;
  error: string | undefined;
  onChange: (slug: string) => void;
}

/** Members: a read-only preview of the address. Admins: an editable slug. */
function SlugField({ values, editing, event, isAdmin, error, onChange }: SlugFieldProps): ReactNode {
  const year = previewYear(values);
  if (isAdmin) {
    return (
      <Field
        label="Dirección (slug)"
        showOptional={!editing}
        required={editing}
        hint={editing ? `/eventos/${year}/…  Letras minúsculas, números y guiones.` : `Déjala vacía para generarla. Si no: /eventos/${year}/tu-direccion`}
        error={error}
      >
        {(p) => (
          <TextInput
            {...p}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            inputMode="url"
            maxLength={60}
            value={values.slug}
            onChange={(e) => onChange(e.target.value)}
          />
        )}
      </Field>
    );
  }
  if (editing && event !== undefined) {
    return (
      <div className={styles.slugPreview}>
        <p className={styles.slugLabel}>Dirección</p>
        <p className={styles.slugValue}>{`/eventos/${event.year}/${event.slug}`}</p>
        <p className={styles.slugNote}>No cambia aunque cambies el título.</p>
      </div>
    );
  }
  return (
    <div className={styles.slugPreview} data-testid="slug-preview">
      <p className={styles.slugLabel}>Así quedará la dirección</p>
      <p className={styles.slugValue}>{slugPreview(values.title, year)}</p>
      <p className={styles.slugNote}>Al guardar, {SLUG_CODE_NOTE} al final para que sea única.</p>
    </div>
  );
}
