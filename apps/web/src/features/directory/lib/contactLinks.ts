/**
 * Contact links for a directory entry. Each builder returns `null` when the
 * value can't make a safe link, and the detail then shows no button for it.
 *
 * Country codes are never guessed: a 10-digit number typed without `+` could
 * be Mexican, from the US or Canada, etc. Until the server stores E.164
 * (T5-BE request), such a number is "local": it can be dialled as typed, but
 * gets no `wa.me` link (WhatsApp needs the country code).
 */

/** E.164 allows at most 15 digits; shorter than 8 can't be a full number. */
const MIN_DIGITS = 8;
const MAX_DIGITS = 15;
/** Shortest local number worth a `tel:` link. */
const MIN_LOCAL_DIGITS = 7;
/** A number typed without `+`/`00` this long already carries a country code. */
const MIN_DIGITS_WITH_COUNTRY = 11;

/** How a stored phone can be dialled. */
export type PhoneKind =
  /** Has a country code (`+…`, `00…`, or 11–15 digits): WhatsApp and international `tel:`. */
  | { kind: "international"; digits: string }
  /** No country code (e.g. 10 digits): `tel:` as typed, no WhatsApp. */
  | { kind: "local"; digits: string }
  | { kind: "invalid" };

/**
 * Classifies a phone as family members type it ("+52 (555) 010-0101",
 * "0052 555…", "555 010 0101").
 *
 * @param phone - The phone as stored.
 * @returns Its digits and whether they include a country code.
 */
export function classifyPhone(phone: string): PhoneKind {
  const trimmed = phone.trim();
  let digits = trimmed.replace(/\D/g, "");
  let explicit = trimmed.startsWith("+");
  if (!explicit && digits.startsWith("00")) {
    digits = digits.slice(2);
    explicit = true;
  }
  if (explicit || digits.length >= MIN_DIGITS_WITH_COUNTRY) {
    return digits.length >= MIN_DIGITS && digits.length <= MAX_DIGITS ? { kind: "international", digits } : { kind: "invalid" };
  }
  return digits.length >= MIN_LOCAL_DIGITS ? { kind: "local", digits } : { kind: "invalid" };
}

/**
 * International digits of a phone, or `null` when it has no country code or
 * can't be a full number (no country code is ever assumed).
 *
 * @param phone - The phone as stored.
 * @returns Digits with the country code, or `null`.
 */
export function internationalDigits(phone: string): string | null {
  const kind = classifyPhone(phone);
  return kind.kind === "international" ? kind.digits : null;
}

/**
 * @param phone - The phone as stored.
 * @returns `https://wa.me/<digits>`, or `null` without a country code.
 */
export function whatsappHref(phone: string): string | null {
  const digits = internationalDigits(phone);
  return digits === null ? null : `https://wa.me/${digits}`;
}

/**
 * @param phone - The phone as stored.
 * @returns `tel:+<digits>` for an international number, `tel:<digits>` for a local one, or `null`.
 */
export function telHref(phone: string): string | null {
  const kind = classifyPhone(phone);
  if (kind.kind === "international") return `tel:+${kind.digits}`;
  if (kind.kind === "local") return `tel:${kind.digits}`;
  return null;
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
