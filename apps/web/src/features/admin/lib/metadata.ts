/**
 * Audit metadata is free-form JSON written by many tracks. It is shown as a
 * plain key/value list: every value becomes a **string** rendered as a React
 * text node, never as HTML, so a stored `<img onerror>` stays inert text.
 */

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
