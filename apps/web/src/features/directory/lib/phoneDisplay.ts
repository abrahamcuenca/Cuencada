/**
 * Readable phone text for the directory (WP-4.4b). The server sends E.164
 * (`+525550100144`) as `display`; this only regroups the digits for reading
 * (`+52 555 010 0144`). Links still use the server's `href` unchanged.
 *
 * Grouping is known only for the family's main calling codes (+52 México,
 * +1 US/Canada: 10 national digits as 3-3-4). Any other value is returned
 * as-is rather than grouped wrongly.
 */

/** Calling codes whose 10-digit national numbers are shown as 3-3-4. */
const TEN_DIGIT_CODES = ["52", "1"] as const;

/**
 * @param display - The server's `display` text for a phone or WhatsApp item.
 * @returns The number grouped for reading, or `display` unchanged.
 */
export function formatPhoneDisplay(display: string): string {
  const match = /^\+([0-9]{8,15})$/.exec(display);
  const digits = match?.[1];
  if (digits === undefined) return display;
  for (const code of TEN_DIGIT_CODES) {
    const national = digits.slice(code.length);
    if (digits.startsWith(code) && national.length === 10) {
      return `+${code} ${national.slice(0, 3)} ${national.slice(3, 6)} ${national.slice(6)}`;
    }
  }
  return display;
}
