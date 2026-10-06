/**
 * CSV rendering for admin exports: RFC 4180 quoting, CRLF line endings, a
 * UTF-8 BOM (so Excel shows accents) and formula-injection protection.
 */

/** UTF-8 byte order mark; Excel needs it to read the file as UTF-8. */
export const CSV_BOM = "\uFEFF";

/**
 * Characters that make spreadsheet apps treat a cell as a formula (or that
 * can smuggle one past a naive check). Cells starting with any of them get a
 * leading apostrophe (OWASP "CSV injection").
 */
const FORMULA_TRIGGER = /^[=+\-@\t\r]/;

/** A cell value before rendering. `null` renders as an empty cell. */
export type CsvValue = string | number | boolean | null;

/**
 * Render one cell: neutralize formula triggers, then quote when the value
 * contains a quote, comma, CR or LF (doubling inner quotes).
 *
 * @param value - Raw cell value.
 */
export function csvCell(value: CsvValue): string {
  if (value === null) return "";
  let text = String(value);
  if (FORMULA_TRIGGER.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/**
 * Build a CSV document (with BOM) from a header row and data rows.
 *
 * @param header - Column names.
 * @param rows - One array per row, in header order.
 */
export function toCsv(header: readonly string[], rows: readonly (readonly CsvValue[])[]): string {
  const lines = [header, ...rows].map((row) => row.map(csvCell).join(","));
  return `${CSV_BOM}${lines.join("\r\n")}\r\n`;
}
