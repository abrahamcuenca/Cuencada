import { type ReactNode, useState } from "react";
import { Field } from "../../../shared/ui/Field";
import { IconButton } from "../../../shared/ui/IconButton";
import { TextInput } from "../../../shared/ui/TextInput";
import styles from "../auth.module.css";
import { PASSWORD_RULES, passwordStrength } from "../forms";

/** Props for {@link PasswordField}. */
export interface PasswordFieldProps {
  label: string;
  name: string;
  value: string;
  onChange: (value: string) => void;
  /** `current-password` for login/current, `new-password` for new ones. */
  autoComplete: "current-password" | "new-password";
  error?: string | undefined;
  /** Show the rules and the live strength meter (new passwords only). */
  showStrength?: boolean;
  /** Extra hint (when `showStrength` is off). */
  hint?: string;
  disabled?: boolean;
}

/**
 * Password input with a show/hide toggle and, for new passwords, the rules
 * plus a live length-based strength meter. The rules and meter are in the
 * field's hint, so they are linked through `aria-describedby`.
 */
export function PasswordField({ label, name, value, onChange, autoComplete, error, showStrength = false, hint, disabled = false }: PasswordFieldProps): ReactNode {
  const [visible, setVisible] = useState(false);
  const strength = passwordStrength(value);

  const fieldHint = showStrength ? (
    <>
      {PASSWORD_RULES}
      {value.length > 0 ? (
        <span className={styles.strength} data-level={strength.level}>
          <span className={styles.meter} aria-hidden="true">
            {[0, 1, 2, 3].map((step) => (
              <span key={step} className={styles.meterStep} data-on={step <= strength.score && strength.level !== "short" ? "" : undefined} />
            ))}
          </span>
          <span>{strength.label}</span>
        </span>
      ) : null}
    </>
  ) : (
    hint
  );

  return (
    <Field label={label} hint={fieldHint} error={error} required>
      {(control) => (
        <div className={styles.passwordRow}>
          <TextInput
            {...control}
            name={name}
            type={visible ? "text" : "password"}
            autoComplete={autoComplete}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            value={value}
            disabled={disabled}
            onChange={(event) => onChange(event.target.value)}
          />
          <IconButton
            label="Mostrar contraseña"
            icon={visible ? "🙈" : "👁"}
            variant="plain"
            aria-pressed={visible}
            onClick={() => setVisible((current) => !current)}
          />
        </div>
      )}
    </Field>
  );
}
