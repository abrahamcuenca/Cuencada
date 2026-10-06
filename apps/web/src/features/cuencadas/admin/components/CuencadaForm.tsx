import { type AdminCuencada, type CreateCuencadaInput, type CreateCuencadaRequest, createCuencadaInputSchema } from "@cuencada/types";
import { type FormEvent, type ReactNode, useState } from "react";
import { Button } from "../../../../shared/ui/Button";
import type { SelectOption } from "../../../../shared/ui/Select";
import { forecastUrl } from "../../components/WeatherWidget";
import { blankToNull, type FieldErrors, isoToZonedLocal, issuesToFieldErrors, zonedLocalToIso } from "../forms";
import styles from "../admin.module.css";
import { FormError, type FormValues, SelectField, TextField } from "./fields";

const FIELDS = [
  "year",
  "title",
  "description",
  "city",
  "state",
  "country",
  "timezone",
  "startsAt",
  "endsAt",
  "rsvpDeadline",
  "themeColor",
  "heroImageUrl",
  "songUrl",
  "weatherWidgetUrl",
  "whatsappUrl",
  "externalAlbumUrl"
] as const;
type CuencadaField = (typeof FIELDS)[number];
type CuencadaValues = FormValues<CuencadaField>;

const DEFAULT_TIMEZONE = "America/Merida";

const TIMEZONES: readonly string[] = [
  "America/Merida",
  "America/Cancun",
  "America/Mexico_City",
  "America/Monterrey",
  "America/Chihuahua",
  "America/Hermosillo",
  "America/Mazatlan",
  "America/Tijuana",
  "America/Los_Angeles",
  "America/Chicago",
  "America/New_York",
  "Europe/Madrid"
];

function timezoneOptions(current: string): SelectOption[] {
  const zones = TIMEZONES.includes(current) ? TIMEZONES : [current, ...TIMEZONES];
  return zones.map((zone) => ({ value: zone, label: zone.replace("_", " ") }));
}

function emptyValues(): CuencadaValues {
  return {
    year: "",
    title: "",
    description: "",
    city: "",
    state: "",
    country: "México",
    timezone: DEFAULT_TIMEZONE,
    startsAt: "",
    endsAt: "",
    rsvpDeadline: "",
    themeColor: "#0b5e55",
    heroImageUrl: "",
    songUrl: "",
    weatherWidgetUrl: "",
    whatsappUrl: "",
    externalAlbumUrl: ""
  };
}

function valuesFrom(cuencada: AdminCuencada): CuencadaValues {
  const zone = cuencada.timezone;
  return {
    year: String(cuencada.year),
    title: cuencada.title,
    description: cuencada.description,
    city: cuencada.city,
    state: cuencada.state,
    country: cuencada.country,
    timezone: zone,
    startsAt: isoToZonedLocal(cuencada.startsAt, zone),
    endsAt: isoToZonedLocal(cuencada.endsAt, zone),
    rsvpDeadline: cuencada.rsvpDeadline ? isoToZonedLocal(cuencada.rsvpDeadline, zone) : "",
    themeColor: cuencada.themeColor,
    heroImageUrl: cuencada.heroImageUrl ?? "",
    songUrl: cuencada.songUrl ?? "",
    weatherWidgetUrl: cuencada.weatherWidgetUrl ?? "",
    whatsappUrl: cuencada.whatsappUrl ?? "",
    externalAlbumUrl: cuencada.externalAlbumUrl ?? ""
  };
}

/** The request body (before contract parsing) plus errors found while building it. */
interface Draft {
  body: CreateCuencadaRequest;
  errors: FieldErrors;
}

/** Hint under "Pronóstico del clima": the only URL shape the weather widget renders. */
export const FORECAST_URL_HINT = "Copia la dirección de la ciudad en forecast7.com, p. ej. https://forecast7.com/es/20d97n89d59/merida/ (sin «www.»).";
/** Shown when the forecast URL isn't an `https://forecast7.com/…` page. */
export const FORECAST_URL_ERROR = "Usa una dirección que empiece con https://forecast7.com/ (sin «www.»).";

/** Builds the API body. Wall-clock date-times are read in the chosen timezone. */
function buildDraft(values: CuencadaValues): Draft {
  const errors: FieldErrors = {};
  const zone = values.timezone;
  const year = Number(values.year);
  if (!/^\d{4}$/.test(values.year.trim()) || year < 1900 || year > 2200) errors.year = "Escribe un año entre 1900 y 2200.";

  const instant = (field: "startsAt" | "endsAt" | "rsvpDeadline", required: boolean): string | null => {
    const raw = values[field];
    if (raw === "") {
      if (required) errors[field] = "Este campo es obligatorio.";
      return null;
    }
    const iso = zonedLocalToIso(raw, zone);
    if (iso === null) errors[field] = "Fecha y hora inválidas.";
    return iso;
  };

  const forecast = values.weatherWidgetUrl.trim();
  if (forecast !== "" && forecastUrl(forecast) === null) errors.weatherWidgetUrl = FORECAST_URL_ERROR;

  const startsAt = instant("startsAt", true);
  const endsAt = instant("endsAt", true);
  // Also checked by the schema's refine, but zod skips object refines while any field is invalid.
  if (startsAt && endsAt && Date.parse(endsAt) <= Date.parse(startsAt)) errors.endsAt = "La fecha de fin debe ser posterior al inicio.";

  const body: CreateCuencadaRequest = {
    year,
    title: values.title,
    description: values.description,
    city: values.city,
    state: values.state,
    country: values.country,
    timezone: zone,
    startsAt: startsAt ?? "",
    endsAt: endsAt ?? "",
    rsvpDeadline: instant("rsvpDeadline", false),
    themeColor: values.themeColor,
    heroImageUrl: blankToNull(values.heroImageUrl),
    songUrl: blankToNull(values.songUrl),
    weatherWidgetUrl: blankToNull(values.weatherWidgetUrl),
    whatsappUrl: blankToNull(values.whatsappUrl),
    externalAlbumUrl: blankToNull(values.externalAlbumUrl)
  };
  return { body, errors };
}

/** A validated Cuencada body, without `isPublished` (publishing has its own switch). */
export type CuencadaFormBody = Omit<CreateCuencadaInput, "isPublished">;

/** Result of {@link validateCuencadaForm}. */
export type CuencadaFormResult = { ok: true; body: CuencadaFormBody } | { ok: false; errors: FieldErrors };

/**
 * Validates the form with the contract schema (same rules as the server),
 * returning the canonical body (trimmed text, canonical https links). The
 * form always holds every field, so create and edit share the create schema.
 *
 * @param values - Raw form values.
 * @returns The body to POST or PATCH, or Spanish field errors.
 */
export function validateCuencadaForm(values: CuencadaValues): CuencadaFormResult {
  const draft = buildDraft(values);
  const parsed = createCuencadaInputSchema.safeParse(draft.body);
  if (!parsed.success || Object.keys(draft.errors).length > 0) {
    return { ok: false, errors: { ...(parsed.success ? {} : issuesToFieldErrors(parsed.error.issues)), ...draft.errors } };
  }
  const { isPublished: _isPublished, ...body } = parsed.data;
  return { ok: true, body };
}

/** Props for {@link CuencadaForm}. */
export interface CuencadaFormProps {
  /** `null` to create a new edition. */
  initial: AdminCuencada | null;
  /** Sends the validated body; resolves to server field errors, or `null` on success. */
  onSubmit: (body: CuencadaFormBody) => Promise<FieldErrors | null>;
  submitLabel: string;
  onCancel?: () => void;
}

/**
 * Create/edit form for a Cuencada's data. Date-times are typed as local time
 * **in the edition's timezone** (default America/Merida), whatever the
 * admin's device timezone. Validated client-side with the contract schemas;
 * server errors are mapped back onto the fields.
 */
export function CuencadaForm({ initial, onSubmit, submitLabel, onCancel }: CuencadaFormProps): ReactNode {
  const [values, setValues] = useState<CuencadaValues>(() => (initial ? valuesFrom(initial) : emptyValues()));
  const [errors, setErrors] = useState<FieldErrors>({});
  const [saving, setSaving] = useState(false);

  const onChange = (name: string, value: string): void => {
    setValues((current) => ({ ...current, [name]: value }));
  };

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const result = validateCuencadaForm(values);
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    setErrors({});
    setSaving(true);
    try {
      const serverErrors = await onSubmit(result.body);
      if (serverErrors) setErrors(serverErrors);
    } finally {
      setSaving(false);
    }
  };

  const field = { values, errors, onChange };
  return (
    <form noValidate onSubmit={(event) => void submit(event)} className={styles.form} aria-label={initial ? "Datos de la Cuencada" : "Nueva Cuencada"}>
      <FormError errors={errors} />
      <div className={styles.grid2}>
        <TextField {...bind(field, "year")} label="Año" required inputMode="numeric" maxLength={4} />
        <TextField {...bind(field, "title")} label="Título" required maxLength={200} hint="Por ejemplo: Cuencada 2027" />
      </div>
      <TextField {...bind(field, "description")} label="Descripción" required multiline maxLength={5000} />
      <div className={styles.grid3}>
        <TextField {...bind(field, "city")} label="Ciudad" required maxLength={120} autoComplete="address-level2" />
        <TextField {...bind(field, "state")} label="Estado" required maxLength={120} autoComplete="address-level1" />
        <TextField {...bind(field, "country")} label="País" required maxLength={120} autoComplete="country-name" />
      </div>
      <SelectField
        name="timezone"
        label="Zona horaria"
        hint="Las fechas y horas de abajo se leen en esta zona."
        value={values.timezone}
        options={timezoneOptions(values.timezone)}
        onChange={onChange}
        errors={errors}
      />
      <div className={styles.grid2}>
        <TextField {...bind(field, "startsAt")} label="Inicio" required type="datetime-local" />
        <TextField {...bind(field, "endsAt")} label="Fin" required type="datetime-local" />
      </div>
      <TextField {...bind(field, "rsvpDeadline")} label="Límite para confirmar asistencia" type="datetime-local" />
      <TextField {...bind(field, "themeColor")} label="Color del tema" type="color" hint="Formato #rrggbb." />
      <fieldset className={styles.fieldset}>
        <legend>Enlaces</legend>
        <TextField {...bind(field, "heroImageUrl")} label="Imagen principal" type="url" inputMode="url" hint="https://… o /images/…" />
        <TextField {...bind(field, "songUrl")} label="Canción" type="url" inputMode="url" hint="https://… o /canciones/…" />
        <TextField {...bind(field, "weatherWidgetUrl")} label="Pronóstico del clima" type="url" inputMode="url" hint={FORECAST_URL_HINT} />
        <TextField {...bind(field, "whatsappUrl")} label="Grupo de WhatsApp" type="url" inputMode="url" hint="Solo lo ve la familia con cuenta." />
        <TextField {...bind(field, "externalAlbumUrl")} label="Álbum compartido (OneDrive)" type="url" inputMode="url" hint="Solo lo ve la familia con cuenta." />
      </fieldset>
      <div className={styles.saveBar}>
        {onCancel ? (
          <Button variant="secondary" onClick={onCancel}>
            Cancelar
          </Button>
        ) : null}
        <Button type="submit" loading={saving}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}

function bind(
  field: { values: CuencadaValues; errors: FieldErrors; onChange: (name: string, value: string) => void },
  name: CuencadaField
): { name: string; value: string; errors: FieldErrors; onChange: (name: string, value: string) => void } {
  return { name, value: field.values[name], errors: field.errors, onChange: field.onChange };
}
