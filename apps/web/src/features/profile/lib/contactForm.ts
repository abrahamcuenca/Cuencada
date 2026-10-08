/**
 * Form model for "Mi perfil" → "Contacto" (WP-4.4).
 *
 * The section edits every contact and its "Mostrar a la familia" switch and
 * saves through `PATCH /api/profile/me/contacts` (the only path the web uses
 * for contacts, phone included). Like the main profile form, the PATCH
 * carries only what differs from the server values, validated with the
 * contract's `updateContactsInputSchema` (Spanish messages).
 *
 * - Phone and WhatsApp: a country picker (default +52) plus the number. The
 *   number may also be typed with its own `+lada`, which wins over the picker.
 * - WhatsApp: "Usar mi teléfono" copies the phone; the server stores exactly
 *   what is sent and never infers it.
 * - Social networks: bare handles. A pasted link gets a clear Spanish error
 *   instead of being parsed ({@link HANDLE_URL_ERROR}).
 * - Website: https only; a bare IP or a private host name gets a soft warning.
 */
import {
  CONTACT_KINDS,
  type ContactVisibility,
  isE164,
  normalizePhoneE164,
  type OwnProfile,
  type UpdateContactsRequest,
  updateContactsInputSchema
} from "@cuencada/types";

/** Social networks edited as handles, in display order. */
export const HANDLE_FIELDS = ["instagram", "facebook", "tiktok", "linkedin", "github"] as const;
export type HandleField = (typeof HANDLE_FIELDS)[number];

/** One calling code the picker offers. */
export interface CountryCode {
  /** Digits only, e.g. `"52"`. */
  code: string;
  /** Spanish label, e.g. `"México (+52)"`. */
  label: string;
}

/**
 * Calling codes offered by the picker (México first: the default). Numbers
 * from anywhere else can be typed with their own `+lada`.
 */
export const COUNTRY_CODES: readonly CountryCode[] = [
  { code: "52", label: "México (+52)" },
  { code: "1", label: "Estados Unidos / Canadá (+1)" },
  { code: "34", label: "España (+34)" },
  { code: "502", label: "Guatemala (+502)" },
  { code: "503", label: "El Salvador (+503)" },
  { code: "504", label: "Honduras (+504)" },
  { code: "506", label: "Costa Rica (+506)" },
  { code: "57", label: "Colombia (+57)" },
  { code: "54", label: "Argentina (+54)" },
  { code: "56", label: "Chile (+56)" },
  { code: "51", label: "Perú (+51)" },
  { code: "593", label: "Ecuador (+593)" },
  { code: "58", label: "Venezuela (+58)" },
  { code: "53", label: "Cuba (+53)" },
  { code: "44", label: "Reino Unido (+44)" },
  { code: "49", label: "Alemania (+49)" },
  { code: "33", label: "Francia (+33)" },
  { code: "39", label: "Italia (+39)" }
];

/** The picker's default (México). */
export const DEFAULT_COUNTRY_CODE = "52";

/** A phone as the inputs hold it: calling code + the number as typed. */
export interface PhoneParts {
  country: string;
  number: string;
}

/** Values of the Contacto section, as the inputs hold them. */
export interface ContactFormValues {
  phone: PhoneParts;
  /** "Usar mi teléfono": WhatsApp follows the phone. */
  whatsappSameAsPhone: boolean;
  whatsapp: PhoneParts;
  instagram: string;
  facebook: string;
  tiktok: string;
  linkedin: string;
  github: string;
  website: string;
  visibility: ContactVisibility;
}

/** Fields that can carry an error. */
export type ContactField = "phone" | "whatsapp" | HandleField | "website";

/** Field errors keyed by field. */
export type ContactFormErrors = Partial<Record<ContactField, string>>;

/** Result of {@link buildContactsPatch}. */
export type ContactsPatchResult = { ok: true; patch: UpdateContactsRequest | null } | { ok: false; errors: ContactFormErrors };

/** The stored phone and WhatsApp (to detect a legacy phone and real changes). */
export interface StoredPhones {
  phone: string | null;
  whatsapp: string | null;
}

/** Error for a pasted profile link in a handle field. */
export const HANDLE_URL_ERROR = "Escribe solo tu usuario, sin el enlace.";

/** Fields in form order; the first invalid one gets focus. */
export const CONTACT_FIELDS: readonly ContactField[] = ["phone", "whatsapp", ...HANDLE_FIELDS, "website"];

const EMPTY_VISIBILITY: ContactVisibility = {
  email: false,
  phone: false,
  whatsapp: false,
  instagram: false,
  facebook: false,
  tiktok: false,
  linkedin: false,
  github: false,
  website: false
};

/** Calling codes, longest first, so `+502…` is not read as `+50…`. */
const CODES_LONGEST_FIRST = [...COUNTRY_CODES].sort((a, b) => b.code.length - a.code.length);

/**
 * Split a stored phone into picker + number. An E.164 value is split on the
 * longest known calling code (unknown codes stay in the number with their
 * `+`). A legacy free-form value is kept as typed with the default code, so
 * the owner can confirm it; nothing is guessed silently.
 *
 * @param stored - The stored phone, or `null`.
 */
export function splitPhone(stored: string | null): PhoneParts {
  if (stored === null || stored === "") return { country: DEFAULT_COUNTRY_CODE, number: "" };
  if (!isE164(stored)) return { country: DEFAULT_COUNTRY_CODE, number: stored };
  const digits = stored.slice(1);
  const match = CODES_LONGEST_FIRST.find((country) => digits.startsWith(country.code));
  if (match === undefined) return { country: DEFAULT_COUNTRY_CODE, number: stored };
  return { country: match.code, number: digits.slice(match.code.length) };
}

/**
 * The raw phone to send: blank → `null`; a number typed with its own `+` or
 * `00` is sent as is; otherwise `+<code> <number>`. The server (and the
 * contract schema here) normalize it to E.164 or reject it.
 *
 * @param parts - Picker + number.
 */
export function composePhone(parts: PhoneParts): string | null {
  const number = parts.number.trim();
  if (number === "") return null;
  if (number.startsWith("+") || number.startsWith("00")) return number;
  return `+${parts.country} ${number}`;
}

/**
 * @param profile - The server profile.
 * @returns The section's values (`null` becomes "").
 */
export function toContactFormValues(profile: OwnProfile): ContactFormValues {
  const contacts = profile.contacts;
  const whatsapp = contacts?.whatsapp ?? null;
  return {
    phone: splitPhone(profile.phone),
    // "Usar mi teléfono" is on when WhatsApp already is the phone, or when neither is set yet.
    whatsappSameAsPhone: whatsapp === null ? profile.phone === null : whatsapp === profile.phone,
    whatsapp: splitPhone(whatsapp),
    instagram: contacts?.instagram ?? "",
    facebook: contacts?.facebook ?? "",
    tiktok: contacts?.tiktok ?? "",
    linkedin: contacts?.linkedin ?? "",
    github: contacts?.github ?? "",
    website: contacts?.website ?? "",
    visibility: contacts?.visibility ?? { ...EMPTY_VISIBILITY, email: profile.visibility.showEmail, phone: profile.visibility.showPhone }
  };
}

/** The raw WhatsApp to send for the current values. */
function whatsappRaw(values: ContactFormValues): string | null {
  return values.whatsappSameAsPhone ? composePhone(values.phone) : composePhone(values.whatsapp);
}

/** Comparable value of a phone-like field: E.164 when valid, else the raw text. */
function comparablePhone(raw: string | null): string | null {
  if (raw === null) return null;
  return normalizePhoneE164(raw) ?? raw;
}

/** A handle as stored: trimmed, one leading `@` dropped, blank → `null`. */
function handleValue(raw: string): string | null {
  const trimmed = raw.trim();
  const handle = trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;
  return handle === "" ? null : handle;
}

/**
 * True when a handle field holds a link (or a domain) instead of a username,
 * e.g. `https://instagram.com/prima`, `instagram.com/prima`, `www.tiktok.com/@x`.
 *
 * @param value - The typed value.
 */
export function looksLikeProfileUrl(value: string): boolean {
  const trimmed = value.trim().toLowerCase();
  return (
    /[/:?#]/.test(trimmed) || trimmed.startsWith("www.") || /(?:^|\.)(?:instagram|facebook|fb|tiktok|linkedin|github)\.(?:com|me)\b/.test(trimmed)
  );
}

/** Private, local or numeric hosts: the link may not open for the family. */
const PRIVATE_HOST =
  /^(?:localhost|\[.*\]|(?:\d{1,3}\.){3}\d{1,3})$|\.(?:local|lan|home|internal|intranet|corp|localdomain|test|invalid|example)$/i;

/**
 * Soft warning for a website whose host is a bare IP address or a private
 * name (`localhost`, `*.local`, `*.lan`…). Not an error: it can still be saved.
 *
 * @param value - The typed website.
 * @returns A Spanish warning, or `null`.
 */
export function websiteWarning(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  let host: string;
  try {
    host = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`).hostname;
  } catch {
    return null;
  }
  return PRIVATE_HOST.test(host) ? "Parece una dirección privada o numérica: puede que la familia no pueda abrirla." : null;
}

/**
 * Builds the PATCH body from the values that differ from the baseline and
 * validates it with the contract schema. A legacy (non-E.164) stored phone
 * always counts as changed, so saving confirms it with a country code.
 *
 * @param baseline - Values from the server profile.
 * @param values - Current values.
 * @param stored - The stored phone/WhatsApp (to detect a legacy phone).
 * @returns The patch (`null` when nothing changed) or the field errors.
 */
export function buildContactsPatch(baseline: ContactFormValues, values: ContactFormValues, stored: StoredPhones): ContactsPatchResult {
  const body: Record<string, unknown> = {};
  const errors: ContactFormErrors = {};

  const phone = composePhone(values.phone);
  if (comparablePhone(phone) !== stored.phone) body.phone = phone;
  const whatsapp = whatsappRaw(values);
  if (comparablePhone(whatsapp) !== stored.whatsapp) body.whatsapp = whatsapp;

  for (const field of HANDLE_FIELDS) {
    if (handleValue(values[field]) === handleValue(baseline[field])) continue;
    if (looksLikeProfileUrl(values[field])) errors[field] = HANDLE_URL_ERROR;
    body[field] = handleValue(values[field]);
  }
  if (values.website.trim() !== baseline.website.trim()) body.website = values.website.trim() === "" ? null : values.website.trim();

  const visibility: Partial<ContactVisibility> = {};
  for (const kind of CONTACT_KINDS) {
    if (values.visibility[kind] !== baseline.visibility[kind]) visibility[kind] = values.visibility[kind];
  }
  if (Object.keys(visibility).length > 0) body.visibility = visibility;

  if (Object.keys(body).length === 0 && Object.keys(errors).length === 0) return { ok: true, patch: null };

  const parsed = updateContactsInputSchema.safeParse(body);
  if (parsed.success && Object.keys(errors).length === 0) {
    // The normalized output (E.164, bare handles, canonical https) is also valid input.
    const patch: UpdateContactsRequest = parsed.data;
    return { ok: true, patch };
  }
  for (const issue of parsed.error?.issues ?? []) {
    const key = issue.path[0];
    if (typeof key === "string" && isContactField(key)) errors[key] ??= issue.message;
  }
  return { ok: false, errors };
}

function isContactField(key: string): key is ContactField {
  return (CONTACT_FIELDS as readonly string[]).includes(key);
}

/**
 * Whether the section has something to save (enables "Guardar contacto").
 *
 * @param baseline - Values from the server profile.
 * @param values - Current values.
 * @param stored - The stored phone/WhatsApp.
 */
export function hasContactChanges(baseline: ContactFormValues, values: ContactFormValues, stored: StoredPhones): boolean {
  const result = buildContactsPatch(baseline, values, stored);
  return !result.ok || result.patch !== null;
}
