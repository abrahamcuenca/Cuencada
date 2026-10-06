import { formatDate } from "../../../shared/lib/dates";
import { PORTAL_TIME_ZONE } from "../../auth/sessionDisplay";

/**
 * Admin timestamps: `es-MX`, in the portal timezone (never the device's).
 *
 * @param value - An ISO instant.
 * @returns e.g. `"6 oct 2026, 10:30 a.m."`.
 */
export function formatInstant(value: string): string {
  return formatDate(value, PORTAL_TIME_ZONE, { dateStyle: "medium", timeStyle: "short" });
}
