import { type LocationItem, RSVP_MAX_GUESTS, RSVP_NOTES_MAX_LENGTH, type RsvpStatus } from "@cuencada/types";
import { type FormEvent, type ReactNode, useId } from "react";
import { Button } from "../../../shared/ui/Button";
import { Field } from "../../../shared/ui/Field";
import { IconButton } from "../../../shared/ui/IconButton";
import { Select } from "../../../shared/ui/Select";
import { TextArea } from "../../../shared/ui/TextArea";
import { TextInput } from "../../../shared/ui/TextInput";
import { clampGuests, type DateWindow, type RsvpDraft, type RsvpFieldErrors } from "../lib/rsvpForm";
import styles from "../rsvp.module.css";

/** Props for {@link RsvpForm}. */
export interface RsvpFormProps {
  year: number;
  draft: RsvpDraft;
  errors: RsvpFieldErrors;
  /** The edition's `hotel` locations (members details). */
  hotels: readonly LocationItem[];
  dateWindow: DateWindow;
  saving: boolean;
  onChange: (draft: RsvpDraft) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  /** Shown as "Cancelar" when editing an existing answer. */
  onCancel?: (() => void) | undefined;
}

const STATUS_OPTIONS: readonly { value: RsvpStatus; label: string; icon: string }[] = [
  { value: "yes", label: "Sí", icon: "🙌" },
  { value: "maybe", label: "Tal vez", icon: "🤔" },
  { value: "no", label: "No", icon: "😢" }
];

/**
 * The RSVP form: Sí / Tal vez / No as big segmented radios, then (unless
 * "No") a 0–20 guest stepper, arrival/departure native date inputs limited to
 * the edition's window, the hotel select, and notes.
 */
export function RsvpForm({ year, draft, errors, hotels, dateWindow, saving, onChange, onSubmit, onCancel }: RsvpFormProps): ReactNode {
  const statusErrorId = useId();
  const attending = draft.status !== null && draft.status !== "no";
  const set = <TKey extends keyof RsvpDraft>(key: TKey, value: RsvpDraft[TKey]): void => onChange({ ...draft, [key]: value });

  return (
    <form className={styles.form} onSubmit={onSubmit} noValidate>
      <fieldset className={styles.segmented} aria-describedby={errors.status ? statusErrorId : undefined}>
        <legend className={styles.question}>¿Vas a la Cuencada {year}?</legend>
        <div className={styles.segments}>
          {STATUS_OPTIONS.map((option) => (
            <label key={option.value} className={styles.segment}>
              <input
                type="radio"
                name="rsvp-status"
                value={option.value}
                checked={draft.status === option.value}
                onChange={() => set("status", option.value)}
                className="visually-hidden"
              />
              <span aria-hidden="true" className={styles.segmentIcon}>
                {option.icon}
              </span>
              <span>{option.label}</span>
            </label>
          ))}
        </div>
        {errors.status ? (
          <p id={statusErrorId} className={styles.fieldError}>
            <span aria-hidden="true">⚠️ </span>
            {errors.status}
          </p>
        ) : null}
      </fieldset>

      {attending ? (
        <>
          <Field label="Acompañantes" hint={`Además de ti (0 a ${RSVP_MAX_GUESTS}).`} error={errors.guestCount}>
            {(control) => (
              <div className={styles.stepper}>
                <IconButton
                  label="Quitar un acompañante"
                  icon="−"
                  disabled={draft.guestCount <= 0}
                  onClick={() => set("guestCount", clampGuests(draft.guestCount - 1))}
                />
                <TextInput
                  {...control}
                  className={styles.stepperInput}
                  inputMode="numeric"
                  pattern="[0-9]*"
                  autoComplete="off"
                  value={String(draft.guestCount)}
                  onChange={(event) => set("guestCount", clampGuests(Number(event.target.value.replace(/\D/g, "") || "0")))}
                />
                <IconButton
                  label="Agregar un acompañante"
                  icon="+"
                  disabled={draft.guestCount >= RSVP_MAX_GUESTS}
                  onClick={() => set("guestCount", clampGuests(draft.guestCount + 1))}
                />
              </div>
            )}
          </Field>

          <div className={styles.dates}>
            <Field label="Llegada" error={errors.arrivalDate} showOptional>
              {(control) => (
                <TextInput
                  {...control}
                  type="date"
                  min={dateWindow.min}
                  max={dateWindow.max}
                  value={draft.arrivalDate}
                  onChange={(event) => set("arrivalDate", event.target.value)}
                />
              )}
            </Field>
            <Field label="Salida" error={errors.departureDate} showOptional>
              {(control) => (
                <TextInput
                  {...control}
                  type="date"
                  min={draft.arrivalDate !== "" && draft.arrivalDate > dateWindow.min ? draft.arrivalDate : dateWindow.min}
                  max={dateWindow.max}
                  value={draft.departureDate}
                  onChange={(event) => set("departureDate", event.target.value)}
                />
              )}
            </Field>
          </div>

          {hotels.length > 0 ? (
            <Field label="Hotel" error={errors.hotelLocationId} showOptional>
              {(control) => (
                <Select
                  {...control}
                  placeholder="Aún no sé / otro lugar"
                  options={hotels.map((hotel) => ({ value: hotel.id, label: hotel.name }))}
                  value={draft.hotelLocationId}
                  onChange={(event) => set("hotelLocationId", event.target.value)}
                />
              )}
            </Field>
          ) : null}
        </>
      ) : null}

      <Field label="Notas para los organizadores" hint="Alergias, necesidades especiales, etc." error={errors.notes} showOptional>
        {(control) => (
          <TextArea
            {...control}
            rows={3}
            maxLength={RSVP_NOTES_MAX_LENGTH}
            value={draft.notes}
            onChange={(event) => set("notes", event.target.value)}
          />
        )}
      </Field>

      <div className={styles.actions}>
        {onCancel ? (
          <Button variant="secondary" onClick={onCancel} disabled={saving}>
            Cancelar
          </Button>
        ) : null}
        <Button type="submit" loading={saving}>
          Guardar respuesta
        </Button>
      </div>
    </form>
  );
}
