/**
 * Form helpers shared by the T1 pages: zod-driven field errors, Spanish
 * error copy for server responses, and the password-strength hint.
 */
import { type ErrorCode, PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "@cuencada/types";
import { type RefObject, useCallback, useEffect, useRef, useState } from "react";
import { getApiErrorCode, getApiErrorMessage, isAbortError } from "../../shared/api/errors";

/** Field name → Spanish error message. */
export type FieldErrors<TField extends string> = Partial<Record<TField, string | undefined>>;

/** The part of a zod issue the forms use. */
interface SchemaIssue {
  path: readonly PropertyKey[];
  message: string;
}

/** Structural view of a zod schema (keeps `zod` out of the web package's direct deps). */
export interface SafeParser<TData> {
  safeParse: (value: unknown) => { success: true; data: TData } | { success: false; error: { issues: readonly SchemaIssue[] } };
}

/** Result of {@link validateForm}. */
export type FormValidation<TData, TField extends string> =
  | { ok: true; data: TData; errors: FieldErrors<TField> }
  | { ok: false; errors: FieldErrors<TField> };

/**
 * Validates form values with a contract schema and keeps the first message
 * per top-level field.
 *
 * @param schema - A zod schema from `@cuencada/types`.
 * @param values - The raw form values.
 * @returns The parsed data, or the field errors.
 */
export function validateForm<TData, TField extends string>(schema: SafeParser<TData>, values: Record<TField, unknown>): FormValidation<TData, TField> {
  const result = schema.safeParse(values);
  if (result.success) return { ok: true, data: result.data, errors: {} };

  const errors: FieldErrors<TField> = {};
  for (const issue of result.error.issues) {
    const head = issue.path[0];
    if (typeof head !== "string" || !(head in values)) continue;
    // `head in values` proved it is one of the form's own field names.
    const field = head as TField;
    errors[field] ??= issue.message;
  }
  return { ok: false, errors };
}

/**
 * @param errors - Field errors.
 * @returns Whether there is at least one error.
 */
export function hasErrors(errors: FieldErrors<string>): boolean {
  return Object.values(errors).some((message) => message !== undefined);
}

/**
 * Moves focus to the first invalid control of a form after the next render,
 * so screen readers announce its label and linked error.
 *
 * @param formRef - Ref to the form element.
 * @returns A function to call after setting field errors.
 */
export function useFocusFirstInvalid(formRef: RefObject<HTMLFormElement | null>): () => void {
  const [request, setRequest] = useState(0);
  useEffect(() => {
    if (request === 0) return;
    formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [request, formRef]);
  return useCallback(() => setRequest((count) => count + 1), []);
}

/** Mismatched new-password confirmation. */
export const PASSWORDS_DIFFER_MESSAGE = "Las contraseñas no coinciden.";
/** Empty confirmation. */
export const CONFIRM_REQUIRED_MESSAGE = "Escribe la contraseña otra vez.";

/**
 * @param password - The new password.
 * @param confirm - Its confirmation.
 * @returns An error message, or `undefined` when they match.
 */
export function confirmError(password: string, confirm: string): string | undefined {
  if (confirm.length === 0) return CONFIRM_REQUIRED_MESSAGE;
  return password === confirm ? undefined : PASSWORDS_DIFFER_MESSAGE;
}

/** 429 copy (wireframes §3.1). */
export const RATE_LIMITED_MESSAGE = "Demasiados intentos. Espera unos minutos y vuelve a intentarlo.";
/** 401 at login. Identical for unknown emails: no account enumeration. */
export const INVALID_CREDENTIALS_MESSAGE = "El correo o la contraseña no coinciden. Revisa e inténtalo otra vez.";
/** 400 `TOKEN_INVALID` for magic-link, reset and verify links. */
export const LINK_INVALID_MESSAGE = "Este enlace ya se usó o caducó. Pide uno nuevo.";
/** 400 `INVITE_INVALID`. Also covers a bound-email mismatch, so it stays generic. */
export const INVITE_INVALID_MESSAGE = "Esta invitación ya no es válida. Pide a quien te invitó que te mande una nueva.";
/** The link had no usable `#t=` token. */
export const LINK_MISSING_MESSAGE = "Este enlace no es válido o está incompleto. Pide uno nuevo.";

/**
 * Turns an RTK Query error into a message for the form's alert region.
 *
 * - Aborts (the cache was reset by a logout) return `null`: show nothing,
 *   the guards already move the user.
 * - 429 always uses {@link RATE_LIMITED_MESSAGE}.
 * - `overrides` replace the server message for specific codes (generic copy
 *   that must not depend on server wording, e.g. no account enumeration).
 * - Anything else shows the server's Spanish message, or the generic one.
 *
 * @param error - What `.unwrap()` rejected with.
 * @param overrides - Fixed copy per error code.
 * @returns The message, or `null` for an abort.
 */
export function describeAuthError(error: unknown, overrides: Partial<Record<ErrorCode, string>> = {}): string | null {
  if (isAbortError(error)) return null;
  const code = getApiErrorCode(error);
  if (code === "RATE_LIMITED") return RATE_LIMITED_MESSAGE;
  if (code !== null) {
    const override = overrides[code];
    if (override !== undefined) return override;
  }
  return getApiErrorMessage(error);
}

/** Strength levels shown under a new-password field. */
export type PasswordStrengthLevel = "short" | "ok" | "good" | "strong";

/** Live password hint. Length-based: the policy has no composition rules (NIST 800-63B). */
export interface PasswordStrength {
  level: PasswordStrengthLevel;
  /** Spanish label, e.g. "Te faltan 4 caracteres." */
  label: string;
  /** 0–3, for the meter. */
  score: number;
}

/**
 * Rates a new password by length, the only rule the server enforces besides
 * "not only spaces" and the maximum. Counts UTF-16 units, like zod's `min`.
 *
 * @param password - The password being typed.
 * @returns Its level, label and meter score.
 */
export function passwordStrength(password: string): PasswordStrength {
  const length = password.length;
  if (length > PASSWORD_MAX_LENGTH) {
    return { level: "short", label: `Puede tener como máximo ${PASSWORD_MAX_LENGTH} caracteres.`, score: 0 };
  }
  if (length > 0 && password.trim().length === 0) {
    return { level: "short", label: "No puede ser solo espacios.", score: 0 };
  }
  if (length < PASSWORD_MIN_LENGTH) {
    const missing = PASSWORD_MIN_LENGTH - length;
    return { level: "short", label: `Te ${missing === 1 ? "falta 1 carácter" : `faltan ${missing} caracteres`}.`, score: 0 };
  }
  if (length < 16) return { level: "ok", label: "Aceptable. Una frase más larga es más segura.", score: 1 };
  if (length < 20) return { level: "good", label: "Buena.", score: 2 };
  return { level: "strong", label: "Muy buena.", score: 3 };
}

/** Rules shown under every new-password field. */
export const PASSWORD_RULES = `Al menos ${PASSWORD_MIN_LENGTH} caracteres. Usa una frase que recuerdes; los espacios cuentan.`;

/** What {@link usePendingAction} returns. */
export interface PendingAction {
  /** True while a task runs; bind it to the submit button's `loading`. */
  pending: boolean;
  /**
   * Runs `task` unless one is already running (double taps, Enter + click).
   *
   * @returns Whether the task was started.
   */
  run: (task: () => Promise<void>) => Promise<boolean>;
}

/**
 * Tracks one in-flight submit locally. Sensitive mutations are dispatched
 * with `track: false`, so the hook's `isLoading` is not available.
 *
 * @returns The pending flag and a guarded runner.
 */
export function usePendingAction(): PendingAction {
  const [pending, setPending] = useState(false);
  const running = useRef(false);

  const run = useCallback(async (task: () => Promise<void>): Promise<boolean> => {
    if (running.current) return false;
    running.current = true;
    setPending(true);
    try {
      await task();
    } finally {
      running.current = false;
      setPending(false);
    }
    return true;
  }, []);

  return { pending, run };
}
