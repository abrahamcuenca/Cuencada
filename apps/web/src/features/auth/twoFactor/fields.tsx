/**
 * Small pieces shared by the WP-7 screens: the 6-digit code field, the
 * recovery-code field, and Spanish error copy.
 */
import { TOTP_DIGITS } from "@cuencada/types";
import type { ReactNode } from "react";
import { Field } from "../../../shared/ui/Field";
import { TextInput } from "../../../shared/ui/TextInput";
import { describeAuthError } from "../forms";
import styles from "./twoFactor.module.css";

/** 400 `TWO_FACTOR_INVALID`: generic on purpose (no hint about what was wrong). */
export const TWO_FACTOR_INVALID_MESSAGE = "El código no es válido. Revisa tu app e inténtalo de nuevo.";
/** 400 `TOKEN_INVALID` on verify: the challenge expired, was used or burned. */
export const CHALLENGE_EXPIRED_MESSAGE = "La verificación venció o tuvo demasiados intentos. Vuelve a iniciar sesión.";

/**
 * Spanish message for a failed 2FA request.
 *
 * @param error - What `.unwrap()` rejected with.
 * @returns The message, or `null` for an abort.
 */
export function describeTwoFactorError(error: unknown): string | null {
  return describeAuthError(error, { TWO_FACTOR_INVALID: TWO_FACTOR_INVALID_MESSAGE, TOKEN_INVALID: CHALLENGE_EXPIRED_MESSAGE });
}

/** Keep digits only, at most six (paste-friendly: "123 456" → "123456"). */
export function cleanCode(value: string): string {
  return value.replace(/\D+/g, "").slice(0, TOTP_DIGITS);
}

/** Props of {@link CodeField}. */
export interface CodeFieldProps {
  value: string;
  onChange: (value: string) => void;
  error?: string | undefined;
  label?: string;
  hint?: ReactNode;
  autoFocus?: boolean;
}

/**
 * The 6-digit code input: `autocomplete="one-time-code"`, numeric keypad,
 * big monospace digits.
 */
export function CodeField({ value, onChange, error, label = "Código de 6 números", hint, autoFocus = false }: CodeFieldProps): ReactNode {
  return (
    <Field label={label} hint={hint ?? "Ábrelo en tu app de autenticación (Google Authenticator, 1Password, Authy…)."} error={error} required>
      {(control) => (
        <TextInput
          {...control}
          name="code"
          className={styles.codeInput}
          autoComplete="one-time-code"
          inputMode="numeric"
          pattern="[0-9]*"
          maxLength={TOTP_DIGITS}
          autoCapitalize="none"
          spellCheck={false}
          autoFocus={autoFocus}
          value={value}
          onChange={(event) => onChange(cleanCode(event.target.value))}
        />
      )}
    </Field>
  );
}

/** Props of {@link RecoveryCodeField}. */
export interface RecoveryCodeFieldProps {
  value: string;
  onChange: (value: string) => void;
  error?: string | undefined;
}

/** A recovery code input (`xxxx-xxxx-xxxx-xxxx`, case and dashes ignored). */
export function RecoveryCodeField({ value, onChange, error }: RecoveryCodeFieldProps): ReactNode {
  return (
    <Field label="Código de recuperación" hint="Uno de los 10 códigos que guardaste al activar la verificación. Cada uno sirve una vez." error={error} required>
      {(control) => (
        <TextInput
          {...control}
          name="recoveryCode"
          className={styles.secret}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          maxLength={40}
          placeholder="xxxx-xxxx-xxxx-xxxx"
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
    </Field>
  );
}
