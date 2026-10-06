/**
 * Audit metadata is free-form JSON written by many tracks. It is shown as a
 * plain key/value list: every value becomes a **string** rendered as a React
 * text node, never as HTML, so a stored `<img onerror>` stays inert text.
 */

/** A badge derived from the admin-alert audit metadata (T8-BE, WP-2.3b). */
export interface AlertFlag {
  key: "adminAlertExempt" | "adminAlertLimitNotice" | "adminAlertSkipped" | "inviteAlertLimitNotice" | "inviteAlertSkipped";
  label: string;
  tone: "accent" | "danger" | "festive";
}

/**
 * Badges for the admin-alert flags T8-BE writes on admin-account changes:
 * - `adminAlertExempt`: always announced, even past the daily cap;
 * - `adminAlertLimitNotice`: this change sent the day's single "límite de avisos" email instead;
 * - `adminAlertSkipped`: no alert email went out for this change;
 * - `inviteAlertLimitNotice` (WP-2.3b): this open-invite acceptance sent the day's single limit notice instead;
 * - `inviteAlertSkipped` (WP-2.3b): an open-invite acceptance sent no admin alert (daily cap reached).
 * Only literal `true` counts (metadata is free-form JSON).
 *
 * @param metadata - An audit entry's metadata.
 * @returns The badges to show, in a fixed order.
 */
export function alertFlags(metadata: Record<string, unknown>): AlertFlag[] {
  const flags: AlertFlag[] = [];
  if (metadata.adminAlertExempt === true) flags.push({ key: "adminAlertExempt", label: "Aviso obligatorio", tone: "festive" });
  if (metadata.adminAlertLimitNotice === true) flags.push({ key: "adminAlertLimitNotice", label: "Límite de avisos alcanzado", tone: "accent" });
  if (metadata.adminAlertSkipped === true) flags.push({ key: "adminAlertSkipped", label: "Aviso no enviado", tone: "danger" });
  if (metadata.inviteAlertLimitNotice === true) {
    flags.push({ key: "inviteAlertLimitNotice", label: "Límite de avisos alcanzado", tone: "accent" });
  }
  if (metadata.inviteAlertSkipped === true) flags.push({ key: "inviteAlertSkipped", label: "Aviso no enviado", tone: "danger" });
  return flags;
}

/** Characters of an entity id shown on phones (the full id stays in `title` and on wider screens). */
export const SHORT_ID_LENGTH = 8;

/**
 * @param id - An entity id (UUID or other short string).
 * @returns The first {@link SHORT_ID_LENGTH} characters plus "…" when longer.
 */
export function shortId(id: string): string {
  return id.length > SHORT_ID_LENGTH + 1 ? `${id.slice(0, SHORT_ID_LENGTH)}…` : id;
}

/** One metadata row. */
export interface MetadataRow {
  key: string;
  value: string;
}

/** Longest value shown before cutting it (the full JSON is never needed on a phone). */
export const METADATA_VALUE_MAX = 300;

function clip(text: string): string {
  return text.length > METADATA_VALUE_MAX ? `${text.slice(0, METADATA_VALUE_MAX)}…` : text;
}

/**
 * @param value - Any JSON value.
 * @returns A short, human string: booleans as Sí/No, arrays of scalars joined, objects as JSON.
 */
export function formatMetadataValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "boolean") return value ? "Sí" : "No";
  if (typeof value === "string") return clip(value);
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  if (Array.isArray(value) && value.every((item) => item === null || typeof item !== "object")) {
    return value.length === 0 ? "—" : clip(value.map((item) => formatMetadataValue(item)).join(", "));
  }
  try {
    return clip(JSON.stringify(value) ?? "—");
  } catch {
    return "—";
  }
}

/**
 * @param metadata - An audit entry's metadata.
 * @returns Rows in the stored key order.
 */
export function metadataRows(metadata: Record<string, unknown>): MetadataRow[] {
  return Object.entries(metadata).map(([key, value]) => ({ key, value: formatMetadataValue(value) }));
}
