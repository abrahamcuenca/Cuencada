import { ITINERARY_TAG_MAX_LENGTH, ITINERARY_TAGS_MAX, itineraryTagSchema } from "@cuencada/types";
import { type HTMLAttributes, type KeyboardEvent, type ReactNode, useState } from "react";
import { Button } from "../../../../shared/ui/Button";
import { Field } from "../../../../shared/ui/Field";
import { type SelectOption, Select } from "../../../../shared/ui/Select";
import { TextArea } from "../../../../shared/ui/TextArea";
import { TextInput } from "../../../../shared/ui/TextInput";
import type { FieldErrors } from "../forms";
import styles from "../admin.module.css";

/** String-only form state, keyed by field name. */
export type FormValues<TKey extends string> = Record<TKey, string>;

/** Props for {@link TextField}. */
export interface TextFieldProps {
  name: string;
  label: string;
  value: string;
  onChange: (name: string, value: string) => void;
  errors: FieldErrors;
  hint?: string | undefined;
  required?: boolean;
  type?: "text" | "url" | "date" | "time" | "datetime-local" | "color";
  inputMode?: HTMLAttributes<HTMLInputElement>["inputMode"];
  autoComplete?: string;
  multiline?: boolean;
  maxLength?: number | undefined;
}

/**
 * Labelled text input or textarea wired to a string form state. Errors come
 * from {@link FieldErrors} by `name`. 16px text (no iOS zoom), 48px height.
 */
export function TextField({
  name,
  label,
  value,
  onChange,
  errors,
  hint,
  required = false,
  type = "text",
  inputMode,
  autoComplete = "off",
  multiline = false,
  maxLength
}: TextFieldProps): ReactNode {
  return (
    <Field label={label} hint={hint} error={errors[name]} required={required} showOptional>
      {(control) =>
        multiline ? (
          <TextArea {...control} name={name} value={value} maxLength={maxLength} rows={4} onChange={(event) => onChange(name, event.target.value)} />
        ) : (
          <TextInput
            {...control}
            name={name}
            type={type}
            value={value}
            inputMode={inputMode}
            autoComplete={autoComplete}
            maxLength={maxLength}
            onChange={(event) => onChange(name, event.target.value)}
          />
        )
      }
    </Field>
  );
}

/** Props for {@link SelectField}. */
export interface SelectFieldProps {
  name: string;
  label: string;
  value: string;
  options: readonly SelectOption[];
  onChange: (name: string, value: string) => void;
  errors: FieldErrors;
  hint?: string | undefined;
}

/** Labelled native `<select>` (the OS picker on phones). */
export function SelectField({ name, label, value, options, onChange, errors, hint }: SelectFieldProps): ReactNode {
  return (
    <Field label={label} hint={hint} error={errors[name]} required>
      {(control) => <Select {...control} name={name} value={value} options={options} onChange={(event) => onChange(name, event.target.value)} />}
    </Field>
  );
}

/**
 * Adds `raw` to `tags` with the contract's tag rules (trimmed, 1–24 chars, no
 * invisible/bidi characters), skipping a case-insensitive duplicate, at most
 * {@link ITINERARY_TAGS_MAX}.
 *
 * @param tags - Current tags.
 * @param raw - What the admin typed.
 * @returns The new list, or a Spanish error.
 */
export function addTag(tags: readonly string[], raw: string): { ok: true; tags: string[] } | { ok: false; error: string } {
  const parsed = itineraryTagSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Etiqueta inválida." };
  const tag = parsed.data;
  if (tags.some((existing) => existing.toLocaleLowerCase("es") === tag.toLocaleLowerCase("es"))) return { ok: true, tags: [...tags] };
  if (tags.length >= ITINERARY_TAGS_MAX) return { ok: false, error: `Máximo ${ITINERARY_TAGS_MAX} etiquetas.` };
  return { ok: true, tags: [...tags, tag] };
}

/** Props for {@link TagsField}. */
export interface TagsFieldProps {
  name: string;
  label: string;
  tags: readonly string[];
  onChange: (tags: string[]) => void;
  errors: FieldErrors;
}

/**
 * Short labels as removable chips plus an input ("Agregar" or Enter). Rules
 * from the contract: at most {@link ITINERARY_TAGS_MAX} tags of up to
 * {@link ITINERARY_TAG_MAX_LENGTH} characters, no duplicates.
 */
export function TagsField({ name, label, tags, onChange, errors }: TagsFieldProps): ReactNode {
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const full = tags.length >= ITINERARY_TAGS_MAX;

  const add = (): void => {
    if (draft.trim() === "") return;
    const result = addTag(tags, draft);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setError(null);
    setDraft("");
    onChange(result.tags);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key !== "Enter") return;
    // Enter adds the tag instead of submitting the whole activity form.
    event.preventDefault();
    add();
  };

  return (
    <div className={styles.tagsField}>
      <Field
        label={label}
        hint={full ? `Llegaste al máximo de ${ITINERARY_TAGS_MAX} etiquetas.` : `Hasta ${ITINERARY_TAGS_MAX}, de ${ITINERARY_TAG_MAX_LENGTH} caracteres; por ejemplo «Incluye comida».`}
        error={error ?? errors[name]}
        showOptional
      >
        {(control) => (
          <div className={styles.tagInputRow}>
            <TextInput
              {...control}
              name={name}
              value={draft}
              disabled={full}
              maxLength={ITINERARY_TAG_MAX_LENGTH}
              autoComplete="off"
              enterKeyHint="done"
              onKeyDown={onKeyDown}
              onChange={(event) => {
                setDraft(event.target.value);
                setError(null);
              }}
            />
            <Button variant="secondary" disabled={full || draft.trim() === ""} onClick={add}>
              Agregar
            </Button>
          </div>
        )}
      </Field>
      {tags.length > 0 ? (
        <ul className={styles.tagChips} aria-label={`${label}: ${tags.length}`}>
          {tags.map((tag) => (
            <li key={tag} className={styles.tagChip}>
              <span>{tag}</span>
              <button type="button" className={styles.tagRemove} aria-label={`Quitar la etiqueta ${tag}`} onClick={() => onChange(tags.filter((t) => t !== tag))}>
                ×
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** Form-level error (`errors._form`), announced as an alert. */
export function FormError({ errors }: { errors: FieldErrors }): ReactNode {
  if (!errors._form) return null;
  return (
    <p role="alert" className={styles.formError}>
      <span aria-hidden="true">⚠️ </span>
      {errors._form}
    </p>
  );
}

/** Visibility options shared by itinerary, locations and announcements. */
export const VISIBILITY_OPTIONS: readonly SelectOption[] = [
  { value: "public", label: "Pública (todos)" },
  { value: "members", label: "Solo familia (con cuenta)" }
];
