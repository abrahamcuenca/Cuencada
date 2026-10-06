import { EmailRenderError, EmailRenderErrorCode } from "./errors.js";

/** Default locale for every date in an email (design-system §7). */
export const DEFAULT_LOCALE = "es-MX";
/** Default timezone: the Cuencada happens in Mérida. */
export const DEFAULT_TIME_ZONE = "America/Merida";

/** Longest name we print; longer values are truncated with an ellipsis. */
const MAX_NAME_LENGTH = 80;
/** Upper bound for `expiresInMinutes` (30 days). */
const MAX_EXPIRY_MINUTES = 60 * 24 * 30;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Options shared by every template. All are optional.
 */
export interface EmailRenderOptions {
  /** Allow `http://localhost` links (dev only). `https:` is always required otherwise. */
  allowInsecureLinks?: boolean;
  /** IANA timezone for dates. Default `America/Merida`. */
  timeZone?: string;
  /** BCP 47 locale for dates. Default `es-MX`. */
  locale?: string;
  /** Absolute URL of a logo image shown in the header. Same URL rules as links. Omit for a text wordmark. */
  logoUrl?: string;
}

/** Options after defaults and validation. */
export interface ResolvedEmailOptions {
  allowInsecureLinks: boolean;
  timeZone: string;
  locale: string;
  logoUrl: string | null;
}

/**
 * Applies defaults and validates the options (timezone, locale, logo URL).
 *
 * @throws EmailRenderError when an option is invalid.
 */
export function resolveOptions(
  options: EmailRenderOptions = {},
): ResolvedEmailOptions {
  const allowInsecureLinks = options.allowInsecureLinks === true;
  const timeZone = options.timeZone ?? DEFAULT_TIME_ZONE;
  const locale = options.locale ?? DEFAULT_LOCALE;
  try {
    new Intl.DateTimeFormat(locale, { timeZone });
  } catch {
    throw new EmailRenderError(
      EmailRenderErrorCode.InvalidOption,
      "timeZone",
      "Invalid locale or timeZone option.",
    );
  }
  const logoUrl =
    options.logoUrl === undefined
      ? null
      : assertSafeUrl(options.logoUrl, "logoUrl", allowInsecureLinks);
  return { allowInsecureLinks, timeZone, locale, logoUrl };
}

/**
 * Validates a link that goes into an email and returns its canonical form.
 * Only `https:` is accepted, plus `http:` on localhost when `allowInsecureLinks` is set.
 * URLs with embedded credentials are rejected.
 *
 * @param value - The URL to check.
 * @param field - Prop name, used in the error (the value is never echoed).
 * @param allowInsecureLinks - Dev escape hatch for `http://localhost`.
 * @throws EmailRenderError when the URL is malformed or not allowed.
 */
export function assertSafeUrl(
  value: string,
  field: string,
  allowInsecureLinks: boolean,
): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new EmailRenderError(
      EmailRenderErrorCode.InvalidUrl,
      field,
      `${field} is not a valid absolute URL.`,
    );
  }
  if (url.username !== "" || url.password !== "") {
    throw new EmailRenderError(
      EmailRenderErrorCode.InvalidUrl,
      field,
      `${field} must not contain credentials.`,
    );
  }
  if (url.protocol === "https:") {
    return url.href;
  }
  if (
    url.protocol === "http:" &&
    allowInsecureLinks &&
    LOCAL_HOSTS.has(url.hostname)
  ) {
    return url.href;
  }
  throw new EmailRenderError(
    EmailRenderErrorCode.InsecureUrl,
    field,
    `${field} must use https: (http://localhost is allowed only with allowInsecureLinks).`,
  );
}

/** C0/C1 controls plus the Unicode line/paragraph separators. */
function isControlChar(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  return (
    code <= 0x1f ||
    (code >= 0x7f && code <= 0x9f) ||
    code === 0x2028 ||
    code === 0x2029
  );
}

/**
 * Normalizes a user-provided name for display: strips control characters
 * (so a name can never inject a header line into the subject), collapses
 * whitespace and truncates to 80 characters. HTML escaping is left to React.
 *
 * @returns The cleaned name, or `null` when nothing printable remains.
 */
export function cleanName(value: string | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  const cleaned = Array.from(value, (char) =>
    isControlChar(char) ? " " : char,
  )
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned === "") {
    return null;
  }
  const chars = Array.from(cleaned);
  return chars.length > MAX_NAME_LENGTH
    ? `${chars.slice(0, MAX_NAME_LENGTH - 1).join("")}…`
    : cleaned;
}

/**
 * Formats an instant for use mid-sentence: "lunes 14 de septiembre · 7:40 a.m." (design-system §7, lowercase weekday because it is never sentence-initial here).
 *
 * @param value - A `Date` or an ISO-8601 string.
 * @param field - Prop name, used in the error.
 * @throws EmailRenderError when the value is not a valid date.
 */
export function formatDateTime(
  value: Date | string,
  field: string,
  options: ResolvedEmailOptions,
): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new EmailRenderError(
      EmailRenderErrorCode.InvalidDate,
      field,
      `${field} is not a valid date.`,
    );
  }
  const parts = new Intl.DateTimeFormat(options.locale, {
    timeZone: options.timeZone,
    weekday: "long",
    day: "numeric",
    month: "long",
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? "";
  const day = `${part("weekday")} ${part("day")} de ${part("month")}`;
  const time = new Intl.DateTimeFormat(options.locale, {
    timeZone: options.timeZone,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(date);
  // Non-breaking spaces keep "· 7:40 a.m." together on narrow screens.
  return `${day} ·\u00a0${time.replace(/\s/g, "\u00a0")}`;
}

/**
 * Ends a sentence with a period unless it already ends with one
 * (es-MX times end in "a.m."/"p.m.", which would otherwise print "a.m..").
 */
export function endSentence(text: string): string {
  return text.endsWith(".") ? text : `${text}.`;
}

/**
 * Turns a TTL in minutes into Spanish words: "15 minutos", "1 hora", "2 días".
 *
 * @throws EmailRenderError when the value is not an integer between 1 and 43 200.
 */
export function formatDuration(minutes: number, field: string): string {
  if (
    !Number.isInteger(minutes) ||
    minutes < 1 ||
    minutes > MAX_EXPIRY_MINUTES
  ) {
    throw new EmailRenderError(
      EmailRenderErrorCode.InvalidDuration,
      field,
      `${field} must be an integer between 1 and ${MAX_EXPIRY_MINUTES}.`,
    );
  }
  const plural = (n: number, one: string, many: string): string =>
    `${n}\u00a0${n === 1 ? one : many}`;
  if (minutes % (60 * 24) === 0) {
    return plural(minutes / (60 * 24), "día", "días");
  }
  if (minutes % 60 === 0) {
    return plural(minutes / 60, "hora", "horas");
  }
  return plural(minutes, "minuto", "minutos");
}
