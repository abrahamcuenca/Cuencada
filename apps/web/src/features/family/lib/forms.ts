/**
 * Form helpers shared by the self-edit dialog and the admin person editor:
 * string ↔ nullable value conversion and mapping contract (zod) and server
 * validation errors onto fields.
 */
import { parseApiError } from "../../../shared/api/errors";

/** Field name → Spanish error message. `_form` holds errors with no field. */
export type FieldErrors = Partial<Record<string, string>>;

/**
 * @param value - Text from an input.
 * @returns The trimmed text, or `null` when blank (the contract's "clear this field").
 */
export function toNullableText(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * @param value - Text from a year input.
 * @returns `null` when blank, the integer when it is one, or `NaN` so the schema reports it.
 */
export function toNullableYear(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  return /^\d{1,4}$/.test(trimmed) ? Number(trimmed) : Number.NaN;
}

/** A zod issue, reduced to what we read (keeps this file independent of zod's types). */
interface IssueLike {
  code: string;
  path: ReadonlyArray<PropertyKey>;
  message: string;
}

const YEAR_FIELDS: ReadonlySet<string> = new Set(["birthYear", "deathYear"]);
/** zod's own (English) codes for a malformed or out-of-range year. */
const YEAR_RANGE_CODES: ReadonlySet<string> = new Set(["invalid_type", "too_small", "too_big"]);
const YEAR_MESSAGE = "Escribe un año entre 1800 y 2200.";

/**
 * @param issues - `error.issues` from a failed `safeParse`.
 * @returns The first message per top-level field (`_form` for refinements without a path).
 */
export function issuesToFieldErrors(issues: readonly IssueLike[]): FieldErrors {
  const errors: FieldErrors = {};
  for (const issue of issues) {
    const head = issue.path[0];
    const key = typeof head === "string" ? head : "_form";
    if (errors[key] !== undefined) continue;
    errors[key] = YEAR_FIELDS.has(key) && YEAR_RANGE_CODES.has(issue.code) ? YEAR_MESSAGE : issue.message;
  }
  return errors;
}

/**
 * Maps a server error onto fields: `VALIDATION` details by their top-level
 * path, anything else (and details without a known field) into `_form`.
 *
 * @param error - What `.unwrap()` rejected with.
 * @param fallback - Spanish message when the server gave none.
 * @param fields - The form's field names.
 * @returns Field errors to show.
 */
export function serverErrorToFieldErrors(error: unknown, fallback: string, fields: readonly string[]): FieldErrors {
  const parsed = parseApiError(error);
  if (parsed === null) return { _form: fallback };
  const errors: FieldErrors = {};
  for (const detail of parsed.error.details ?? []) {
    const key = detail.path.split(".")[0] ?? "";
    if (fields.includes(key) && errors[key] === undefined) errors[key] = detail.message;
  }
  if (Object.keys(errors).length === 0) errors._form = parsed.error.message;
  return errors;
}
