import { type ReactNode, useId } from "react";
import styles from "./Field.module.css";
import { cx } from "./cx";

/** Accessibility wiring handed to the control rendered inside a {@link Field}. */
export interface FieldControlProps {
  id: string;
  "aria-describedby"?: string;
  "aria-invalid"?: true;
  "aria-required"?: true;
  required?: true;
}

/** Props for {@link Field}. */
export interface FieldProps {
  /** Visible label (always visible; placeholders are not labels). */
  label: ReactNode;
  /** Helper text shown under the label, linked via `aria-describedby`. */
  hint?: ReactNode;
  /** Error message. When present the control gets `aria-invalid` and the message is linked. */
  error?: ReactNode;
  /** Marks the control as required. Optional fields show "(opcional)" instead of asterisks. */
  required?: boolean;
  /** Show the "(opcional)" suffix when not required. Defaults to false. */
  showOptional?: boolean;
  /** Explicit control id; generated when omitted. */
  id?: string;
  className?: string | undefined;
  /** Render prop that receives the id/ARIA wiring to spread on the control. */
  children: (control: FieldControlProps) => ReactNode;
}

/**
 * Label + hint + error wrapper. Generates ids and wires `htmlFor`,
 * `aria-describedby` (hint then error) and `aria-invalid` on the control.
 *
 * @example
 * <Field label="Correo" hint="Te enviaremos un enlace" error={errors.email}>
 *   {(p) => <TextInput {...p} type="email" autoComplete="email" inputMode="email" />}
 * </Field>
 */
export function Field({ label, hint, error, required = false, showOptional = false, id, className, children }: FieldProps): React.ReactNode {
  const generated = useId();
  const controlId = id ?? `field-${generated}`;
  const hintId = `${controlId}-hint`;
  const errorId = `${controlId}-error`;
  const hasError = error !== undefined && error !== null && error !== false && error !== "";

  const describedBy = [hint ? hintId : null, hasError ? errorId : null].filter(Boolean).join(" ");
  const control: FieldControlProps = { id: controlId };
  if (describedBy) control["aria-describedby"] = describedBy;
  if (hasError) control["aria-invalid"] = true;
  if (required) {
    control.required = true;
    control["aria-required"] = true;
  }

  return (
    <div className={cx(styles.field, hasError && styles.hasError, className)}>
      <label htmlFor={controlId} className={styles.label}>
        {label}
        {!required && showOptional ? <span className={styles.optional}> (opcional)</span> : null}
      </label>
      {hint ? (
        <p id={hintId} className={styles.hint}>
          {hint}
        </p>
      ) : null}
      {children(control)}
      {hasError ? (
        <p id={errorId} className={styles.error}>
          <span aria-hidden="true">⚠️ </span>
          {error}
        </p>
      ) : null}
    </div>
  );
}
