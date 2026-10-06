import type { HTMLAttributes, ReactNode } from "react";
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
