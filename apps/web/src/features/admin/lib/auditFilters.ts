/**
 * Audit log filters live in the URL (`?accion=&tipo=&desde=&hasta=&actor=`),
 * so they survive a reload and can be linked (e.g. from a user's sheet).
 * Every param is validated here; an invalid one is ignored, never sent.
 */
import { auditActionSchema, auditEntityTypeSchema, idSchema } from "@cuencada/types";
import { toZonedParts } from "../../../shared/lib/dates";
import type { AuditLogFilter } from "../api";

/** Validated filter values as the form shows them (dates are `YYYY-MM-DD` in the portal timezone). */
export interface AuditFilterValues {
  action: string;
  entityType: string;
  from: string;
  to: string;
  actorUserId: string;
}

/** URL param names (Spanish, like the routes). */
export const AUDIT_PARAM = {
  action: "accion",
  entityType: "tipo",
  from: "desde",
  to: "hasta",
  actorUserId: "actor"
} as const satisfies Record<keyof AuditFilterValues, string>;

const FILTER_KEYS: ReadonlyArray<keyof AuditFilterValues> = ["action", "entityType", "from", "to", "actorUserId"];
const CALENDAR_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;

function isCalendarDate(value: string): boolean {
  const match = CALENDAR_DATE.exec(value);
  if (!match) return false;
  const [, y, m, d] = match.map(Number);
  if (y === undefined || m === undefined || d === undefined) return false;
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

/**
 * @param params - The page's search params.
 * @returns The valid filters; an invalid or unknown value becomes `""`.
 */
export function readAuditFilters(params: URLSearchParams): AuditFilterValues {
  const action = params.get(AUDIT_PARAM.action) ?? "";
  const entityType = params.get(AUDIT_PARAM.entityType) ?? "";
  const from = params.get(AUDIT_PARAM.from) ?? "";
  const to = params.get(AUDIT_PARAM.to) ?? "";
  const actor = params.get(AUDIT_PARAM.actorUserId) ?? "";
  return {
    action: auditActionSchema.safeParse(action).success ? action : "",
    entityType: auditEntityTypeSchema.safeParse(entityType).success ? entityType : "",
    from: isCalendarDate(from) ? from : "",
    to: isCalendarDate(to) ? to : "",
    actorUserId: idSchema.safeParse(actor).success ? actor : ""
  };
}

/**
 * @param values - Filters to write.
 * @returns Search params with only the non-empty filters.
 */
export function writeAuditFilters(values: AuditFilterValues): URLSearchParams {
  const params = new URLSearchParams();
  for (const key of FILTER_KEYS) {
    const value = values[key];
    if (value !== "") params.set(AUDIT_PARAM[key], value);
  }
  return params;
}

/**
 * The UTC instant of local midnight starting `date` in `timeZone`.
 * Two passes of "guess, measure the zone's offset, correct" handle any offset
 * and a DST change on that day.
 *
 * @param date - `YYYY-MM-DD`.
 * @param timeZone - IANA timezone.
 * @returns Milliseconds since the epoch.
 */
export function zonedMidnight(date: string, timeZone: string): number {
  const [y = 0, m = 1, d = 1] = date.split("-").map(Number);
  const target = Date.UTC(y, m - 1, d);
  let guess = target;
  for (let pass = 0; pass < 2; pass += 1) {
    const parts = toZonedParts(new Date(guess), timeZone);
    const seen = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
    guess += target - seen;
  }
  return guess;
}

/** Result of {@link toAuditQuery}. */
export type AuditQueryResult = { ok: true; filter: AuditLogFilter } | { ok: false; error: string };

/**
 * Turns the form values into the API filter. `desde` is the start of that day
 * and `hasta` the end of that day, both in the portal timezone.
 *
 * @param values - Validated filter values.
 * @param timeZone - The portal timezone.
 * @returns The API filter, or a Spanish error for an inverted range.
 */
export function toAuditQuery(values: AuditFilterValues, timeZone: string): AuditQueryResult {
  const filter: AuditLogFilter = {};
  if (values.action !== "") filter.action = values.action;
  if (values.entityType !== "") filter.entityType = values.entityType;
  if (values.actorUserId !== "") filter.actorUserId = values.actorUserId;
  const from = values.from === "" ? null : zonedMidnight(values.from, timeZone);
  const nextDay = values.to === "" ? null : zonedMidnight(isoDayAfter(values.to), timeZone);
  if (from !== null && nextDay !== null && from >= nextDay) {
    return { ok: false, error: "La fecha «hasta» debe ser igual o posterior a «desde»." };
  }
  if (from !== null) filter.from = new Date(from).toISOString();
  if (nextDay !== null) filter.to = new Date(nextDay - 1).toISOString();
  return { ok: true, filter };
}

function isoDayAfter(date: string): string {
  const [y = 0, m = 1, d = 1] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d) + DAY_MS).toISOString().slice(0, 10);
}
