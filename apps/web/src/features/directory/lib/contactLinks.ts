/**
 * Contact links for a directory entry. Each builder returns `null` when the
 * value can't make a safe link, and the detail then shows no button for it.
 */

/** Mexico's country code: a 10-digit number typed without one is assumed to be Mexican. */
const DEFAULT_COUNTRY_CODE = "52";
/** E.164 allows at most 15 digits; shorter than 8 can't be a full number. */
const MIN_DIGITS = 8;
const MAX_DIGITS = 15;

/**
 * International digits of a phone as family members type it
 * ("+52 (555) 010-0101", "555 010 0101", "0052 555…").
 *
 * @param phone - The phone as stored.
 * @returns Digits with the country code, or `null` when it can't be a full number.
 */
export function internationalDigits(phone: string): string | null {
  const trimmed = phone.trim();
  let digits = trimmed.replace(/\D/g, "");
  if (!trimmed.startsWith("+")) {
    if (digits.startsWith("00")) digits = digits.slice(2);
    else if (digits.length === 10) digits = `${DEFAULT_COUNTRY_CODE}${digits}`;
  }
  if (digits.length < MIN_DIGITS || digits.length > MAX_DIGITS) return null;
  return digits;
}

/**
 * @param phone - The phone as stored.
 * @returns `https://wa.me/<digits>` or `null`.
 */
export function whatsappHref(phone: string): string | null {
  const digits = internationalDigits(phone);
  return digits === null ? null : `https://wa.me/${digits}`;
}

/**
 * @param phone - The phone as stored.
 * @returns `tel:+<digits>` or `null`.
 */
export function telHref(phone: string): string | null {
  const digits = internationalDigits(phone);
  return digits === null ? null : `tel:+${digits}`;
}

/**
 * @param email - The address as stored.
 * @returns `mailto:<address>`, or `null` when it has characters that would
 * add headers, parameters or more recipients to the link (`?`, `&`, `#`, `%`, `,`, `;`, spaces…).
 */
export function mailtoHref(email: string): string | null {
  const trimmed = email.trim();
  if (!/^[^\s@?&#%/\\:<>",;]+@[^\s@?&#%/\\:<>",;]+$/.test(trimmed)) return null;
  return `mailto:${trimmed}`;
}
