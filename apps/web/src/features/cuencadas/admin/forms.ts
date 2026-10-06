/**
 * Form helpers for the admin content screens: wall-clock ↔ instant
 * conversion in the Cuencada's timezone, and mapping contract (zod) and
 * server validation errors onto form fields.
 */
import type { ApiErrorDetail } from "@cuencada/types";
import { parseApiError } from "../../../shared/api/errors";
import { toZonedParts } from "../../../shared/lib/dates";

/** Field name → Spanish error message. `_form` holds errors with no field. */
export type FieldErrors = Partial<Record<string, string>>;

const LOCAL_DATETIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** Offset of `timeZone` from UTC at `instantMs`, in minutes (Mérida: -360). */
function offsetMinutes(instantMs: number, timeZone: string): number {
  const parts = toZonedParts(new Date(instantMs), timeZone);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return Math.round((asUtc - Math.floor(instantMs / 1000) * 1000) / 60_000);
}

/**
 * Converts a `datetime-local` value typed by an admin (a wall-clock time in
 * the Cuencada's timezone, not the device's) to an ISO instant with offset.
 *
 * @param value - `YYYY-MM-DDTHH:MM`.
 * @param timeZone - The Cuencada's IANA timezone.
 * @returns e.g. `2026-09-13T00:00:00-06:00`, or `null` when `value` is not a valid local date-time.
 */
export function zonedLocalToIso(value: string, timeZone: string): string | null {
  const match = LOCAL_DATETIME.exec(value);
  if (!match) return null;
  const [, y, mo, d, h, mi] = match.map(Number);
  if (y === undefined || mo === undefined || d === undefined || h === undefined || mi === undefined) return null;
  const wallAsUtc = Date.UTC(y, mo - 1, d, h, mi);
  // Two passes handle a DST change between the guess and the answer.
  let offset = offsetMinutes(wallAsUtc, timeZone);
  offset = offsetMinutes(wallAsUtc - offset * 60_000, timeZone);
  const instant = new Date(wallAsUtc - offset * 60_000);
  if (Number.isNaN(instant.getTime())) return null;
  const sign = offset < 0 ? "-" : "+";
  const abs = Math.abs(offset);
  return `${y}-${pad(mo)}-${pad(d)}T${pad(h)}:${pad(mi)}:00${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/**
 * The `datetime-local` value for an instant, as wall-clock time in the
 * Cuencada's timezone.
 *
 * @param iso - An ISO instant from the API.
 * @param timeZone - The Cuencada's IANA timezone.
 * @returns `YYYY-MM-DDTHH:MM`.
 */
export function isoToZonedLocal(iso: string, timeZone: string): string {
  const parts = toZonedParts(iso, timeZone);
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}`;
}

/**
 * Maps zod issues from a contract schema onto fields (first issue per field).
 *
 * @param issues - `error.issues` from `safeParse`.
 * @returns Errors keyed by the first path segment; root issues go to `_form`.
 */
export function issuesToFieldErrors(issues: ReadonlyArray<{ path: readonly PropertyKey[]; message: string }>): FieldErrors {
  const errors: FieldErrors = {};
  for (const issue of issues) {
    const key = issue.path.length > 0 ? String(issue.path[0]) : "_form";
    errors[key] ??= issue.message;
  }
  return errors;
}

/**
 * Maps a server error onto fields: `VALIDATION` details (`path` like
 * `title` or `body.title`) go to their field, anything else to `_form`.
 *
 * @param error - The error from an RTK Query mutation.
 * @param fallback - Message when the body is not an `ApiError`.
 * @returns Field errors to display.
 */
export function serverErrorToFieldErrors(error: unknown, fallback: string): FieldErrors {
  const parsed = parseApiError(error);
  if (parsed === null) return { _form: fallback };
  const errors: FieldErrors = { _form: parsed.error.message };
  for (const detail of parsed.error.details ?? []) {
    const segments = detail.path.split(".").filter((segment) => segment !== "body");
    const key = segments[0];
    if (key) errors[key] ??= detail.message;
  }
  return errors;
}

/** A per-line import problem, ready to display. */
export interface LineError {
  /** 1-based line number, or `null` for a summary ("Demasiados errores…"). */
  line: number | null;
  message: string;
}

/**
 * Turns `lines.N` details (from `parseDailyMessagesText` or the server's 400)
 * into displayable line errors.
 *
 * @param details - `ApiErrorDetail[]` with `lines.N` paths.
 * @returns Sorted line errors; summaries last.
 */
export function toLineErrors(details: readonly ApiErrorDetail[]): LineError[] {
  return details
    .map((detail) => {
      const match = /^lines\.(\d+)$/.exec(detail.path);
      return { line: match ? Number(match[1]) : null, message: detail.message };
    })
    .sort((a, b) => (a.line ?? Number.MAX_SAFE_INTEGER) - (b.line ?? Number.MAX_SAFE_INTEGER));
}

/**
 * `""` → `null` for optional text inputs.
 *
 * @param value - The raw input.
 * @returns `null` when blank, otherwise the value.
 */
export function blankToNull(value: string): string | null {
  return value.trim() === "" ? null : value;
}
