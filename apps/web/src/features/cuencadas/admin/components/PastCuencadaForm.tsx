import { type CreateCuencadaInput, type CreateCuencadaRequest, CUENCADA_DATES_TOGETHER_MESSAGE, createCuencadaInputSchema } from "@cuencada/types";
import { type FormEvent, type ReactNode, useState } from "react";
import { toZonedParts } from "../../../../shared/lib/dates";
import { Button } from "../../../../shared/ui/Button";
import { blankToNull, type FieldErrors, issuesToFieldErrors, zonedLocalToIso } from "../forms";
import styles from "../admin.module.css";
import { FormError, type FormValues, TextField } from "./fields";

const FIELDS = ["year", "title", "description", "city", "state", "startDate", "endDate", "heroImageUrl"] as const;
type PastField = (typeof FIELDS)[number];
type PastValues = FormValues<PastField>;

/** Past editions are recorded in the family's home timezone. */
const PAST_TIMEZONE = "America/Merida";

/** Hint under the optional dates of a past Cuencada. */
export const PAST_DATES_HINT = "Si no recuerdas las fechas exactas, déjalas vacías";

/** Shown when the year is not before the current one (the server says the same). */
export const PAST_YEAR_ERROR = "Una Cuencada anterior debe ser de un año pasado.";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function emptyValues(): PastValues {
  return { year: "", title: "", description: "", city: "", state: "", startDate: "", endDate: "", heroImageUrl: "" };
}

/** Moves contract/server errors on `startsAt`/`endsAt` onto the form's day fields. */
function toDayFieldErrors(errors: FieldErrors): FieldErrors {
  const { startsAt, endsAt, ...rest } = errors;
  return {
    ...rest,
    ...(startsAt === undefined ? {} : { startDate: startsAt }),
    ...(endsAt === undefined ? {} : { endDate: endsAt })
  };
}

/** The year "today" in the family's timezone. */
export function currentPastYearLimit(now: Date): number {
  return toZonedParts(now, PAST_TIMEZONE).year;
}

/** Validated body of a past (historical) Cuencada, published right away. */
export type PastCuencadaBody = CreateCuencadaInput;

/** Result of {@link validatePastCuencadaForm}. */
export type PastCuencadaResult = { ok: true; body: PastCuencadaBody } | { ok: false; errors: FieldErrors };

/**
 * Validates the "Agregar Cuencada anterior" form: a year before the current
 * one, optional calendar dates (both or neither; the first day starts at
 * 00:00 and the last ends at 23:59 in Mérida), optional place and cover URL.
 * The title defaults to "Cuencada {año}". The body is a historical, published
 * edition (`isHistorical: true`, `isPublished: true`), parsed with the contract schema.
 *
 * @param values - Raw form values.
 * @param now - Current instant, for the year limit.
 * @returns The body to POST, or Spanish field errors.
 */
export function validatePastCuencadaForm(values: PastValues, now: Date): PastCuencadaResult {
  const errors: FieldErrors = {};
  const yearText = values.year.trim();
  const year = Number(yearText);
  if (!/^\d{4}$/.test(yearText) || year < 1900) errors.year = "Escribe un año de cuatro cifras desde 1900.";
  else if (year >= currentPastYearLimit(now)) errors.year = PAST_YEAR_ERROR;

  const dateIso = (field: "startDate" | "endDate", time: string): string | null => {
    const raw = values[field];
    if (raw === "") return null;
    const iso = ISO_DATE.test(raw) ? zonedLocalToIso(`${raw}T${time}`, PAST_TIMEZONE) : null;
    if (iso === null) errors[field] = "Fecha inválida.";
    return iso;
  };
  const startsAt = dateIso("startDate", "00:00");
  const endsAt = dateIso("endDate", "23:59");
  if (values.startDate === "" && values.endDate !== "") errors.startDate = CUENCADA_DATES_TOGETHER_MESSAGE;
  if (values.endDate === "" && values.startDate !== "") errors.endDate = CUENCADA_DATES_TOGETHER_MESSAGE;
  if (values.startDate !== "" && values.endDate !== "" && values.endDate < values.startDate) {
    errors.endDate = "El último día no puede ser anterior al primero.";
  }

  const request: CreateCuencadaRequest = {
    year,
    title: values.title.trim() === "" ? `Cuencada ${yearText}` : values.title,
    description: values.description,
    city: values.city,
    state: values.state,
    timezone: PAST_TIMEZONE,
    startsAt,
    endsAt,
    heroImageUrl: blankToNull(values.heroImageUrl),
    isHistorical: true,
    isPublished: true
  };
  const parsed = createCuencadaInputSchema.safeParse(request);
  if (!parsed.success || Object.keys(errors).length > 0) {
    const schemaErrors = parsed.success ? {} : toDayFieldErrors(issuesToFieldErrors(parsed.error.issues));
    return { ok: false, errors: { ...schemaErrors, ...errors } };
  }
  return { ok: true, body: parsed.data };
}

/** Props for {@link PastCuencadaForm}. */
export interface PastCuencadaFormProps {
  /** Sends the validated body; resolves to server field errors, or `null` on success. */
  onSubmit: (body: PastCuencadaBody) => Promise<FieldErrors | null>;
  onCancel: () => void;
  /** Injected for tests; defaults to the device clock. */
  now?: () => Date;
}

/**
 * "Agregar Cuencada anterior": a short form for an edition that happened
 * before the portal. It is saved published and historical (no RSVP, no chat).
 * Phone-first, one column; the dates are plain calendar days.
 */
export function PastCuencadaForm({ onSubmit, onCancel, now = () => new Date() }: PastCuencadaFormProps): ReactNode {
  const [values, setValues] = useState<PastValues>(emptyValues);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [saving, setSaving] = useState(false);

  const onChange = (name: string, value: string): void => {
    setValues((current) => ({ ...current, [name]: value }));
  };

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const result = validatePastCuencadaForm(values, now());
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    setErrors({});
    setSaving(true);
    try {
      const serverErrors = await onSubmit(result.body);
      if (serverErrors) setErrors(toDayFieldErrors(serverErrors));
    } finally {
      setSaving(false);
    }
  };

  const bind = (name: PastField): { name: string; value: string; errors: FieldErrors; onChange: (name: string, value: string) => void } => ({
    name,
    value: values[name],
    errors,
    onChange
  });

  return (
    <form noValidate onSubmit={(event) => void submit(event)} className={styles.form} aria-label="Cuencada anterior">
      <FormError errors={errors} />
      <div className={styles.grid2}>
        <TextField {...bind("year")} label="Año" required inputMode="numeric" maxLength={4} hint="Un año anterior al actual." />
        <TextField {...bind("title")} label="Título" maxLength={200} hint="Si lo dejas vacío: «Cuencada» y el año." />
      </div>
      <TextField {...bind("description")} label="Descripción" required multiline maxLength={5000} hint="¿Dónde fue? ¿Qué recuerdan?" />
      <div className={styles.grid2}>
        <TextField {...bind("city")} label="Ciudad" maxLength={120} autoComplete="address-level2" />
        <TextField {...bind("state")} label="Estado" maxLength={120} autoComplete="address-level1" />
      </div>
      <div className={styles.grid2}>
        <TextField {...bind("startDate")} label="Primer día" type="date" hint={PAST_DATES_HINT} />
        <TextField {...bind("endDate")} label="Último día" type="date" hint={PAST_DATES_HINT} />
      </div>
      <TextField
        {...bind("heroImageUrl")}
        label="Imagen de portada"
        type="url"
        inputMode="url"
        hint="Opcional: https://… o /images/…"
      />
      <div className={styles.saveBar}>
        <Button variant="secondary" onClick={onCancel}>
          Cancelar
        </Button>
        <Button type="submit" loading={saving}>
          Agregar y publicar
        </Button>
      </div>
    </form>
  );
}
