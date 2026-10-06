/**
 * Client-side file download for data fetched with the authenticated base
 * query. The token never goes into a URL: the bytes are already in memory and
 * are handed to the browser through a short-lived `blob:` URL.
 */

/** UTF-8 byte-order mark, so Excel opens Spanish accents correctly. */
const UTF8_BOM = "\uFEFF";

/** How long the `blob:` URL stays valid after the click (some browsers read it asynchronously). */
const REVOKE_DELAY_MS = 1000;

/**
 * Saves a Blob as a file via a temporary `<a download>`.
 *
 * @param blob - The file contents.
 * @param filename - Suggested file name.
 */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener";
  anchor.hidden = true;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), REVOKE_DELAY_MS);
}

/**
 * Saves CSV text as a `.csv` file (UTF-8 with exactly one BOM). T3-BE sends
 * a BOM, but `Response.text()` (UTF-8 decode) strips it, so it is restored
 * here; text that still starts with one is left alone.
 *
 * @param csv - The CSV text returned by the API.
 * @param filename - Suggested file name.
 */
export function downloadCsv(csv: string, filename: string): void {
  const text = csv.startsWith(UTF8_BOM) ? csv : `${UTF8_BOM}${csv}`;
  downloadBlob(new Blob([text], { type: "text/csv;charset=utf-8" }), filename);
}
