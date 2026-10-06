import { type InputHTMLAttributes, type ReactNode, type Ref, useId } from "react";
import styles from "./Checkbox.module.css";
import { cx, hasContent } from "./cx";

/** Props shared by {@link Checkbox} and {@link Switch}. */
export interface ToggleProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "children"> {
  /** Visible label; the whole row is the tap target (≥ 44px tall). */
  label: ReactNode;
  /** Helper text linked via `aria-describedby`. */
  hint?: ReactNode;
  /** Error text; sets `aria-invalid`. */
  error?: ReactNode;
  ref?: Ref<HTMLInputElement>;
}

interface ToggleWiring {
  inputId: string;
  hintId: string | undefined;
  errorId: string | undefined;
  describedBy: string | undefined;
}

function useToggleWiring(id: string | undefined, hint: ReactNode, error: ReactNode, describedBy: string | undefined): ToggleWiring {
  const generated = useId();
  const inputId = id ?? `toggle-${generated}`;
  const hintId = hasContent(hint) ? `${inputId}-hint` : undefined;
  const errorId = hasContent(error) ? `${inputId}-error` : undefined;
  const ids = [describedBy, hintId, errorId].filter(Boolean).join(" ");
  return { inputId, hintId, errorId, describedBy: ids || undefined };
}

function ToggleRow({
  kind,
  label,
  hint,
  error,
  id,
  className,
  "aria-describedby": ariaDescribedBy,
  ...rest
}: ToggleProps & { kind: "checkbox" | "switch" }): React.ReactNode {
  const { inputId, hintId, errorId, describedBy } = useToggleWiring(id, hint, error, ariaDescribedBy);
  return (
    <div className={cx(styles.row, className)}>
      <input
        {...rest}
        id={inputId}
        type="checkbox"
        role={kind === "switch" ? "switch" : undefined}
        aria-describedby={describedBy}
        aria-invalid={errorId ? true : undefined}
        className={cx(styles.input, kind === "switch" ? styles.switch : styles.checkbox)}
      />
      <div className={styles.text}>
        <label htmlFor={inputId} className={styles.label}>
          {label}
        </label>
        {hintId ? (
          <p id={hintId} className={styles.hint}>
            {hint}
          </p>
        ) : null}
        {errorId ? (
          <p id={errorId} className={styles.error}>
            {error}
          </p>
        ) : null}
      </div>
    </div>
  );
}

/** Native checkbox with a large custom box and a full-row tap target. */
export function Checkbox(props: ToggleProps): React.ReactNode {
  return <ToggleRow {...props} kind="checkbox" />;
}

/**
 * On/off switch (`role="switch"` on a native checkbox) for settings that
 * apply immediately, e.g. profile visibility ("Mostrar mi teléfono a la familia").
 */
export function Switch(props: ToggleProps): React.ReactNode {
  return <ToggleRow {...props} kind="switch" />;
}
