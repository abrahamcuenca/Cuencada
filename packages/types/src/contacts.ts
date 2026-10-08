/**
 * Directory contact information (WP-4.0): per-network handle rules, the E.164
 * phone normalizer, per-field visibility and the server-built `ContactCard`.
 *
 * Re-exported from `profile.ts` (the barrel in `index.ts` is frozen).
 *
 * Security model:
 * - Social networks are stored as **handles only**, never URLs. Each handle
 *   pattern in {@link CONTACT_HANDLE_RULES} is also the database CHECK
 *   (`profiles_<network>_check`, migration 0004), so a value that bypasses
 *   the API still cannot be stored.
 * - Links are built **only** by {@link buildContactCard}, from a fixed
 *   template per kind. Clients render `href` as-is and never build a link
 *   from raw input, so a stored value can never become a `javascript:` or
 *   off-site URL. `buildContactCard` re-validates every value and drops the
 *   ones that fail (fail closed).
 * - Contacts are PII: visible to verified members only, and each field only
 *   when its owner switched it on (default hidden).
 */
import { z } from "zod";
import { canonicalHttpsUrl, emailSchema } from "./common.js";

/* -------------------------------------------------------------------------- */
/* Kinds                                                                       */
/* -------------------------------------------------------------------------- */

/** Every contact a profile can show, in display order. */
export const ContactKind = {
  Email: "email",
  Phone: "phone",
  WhatsApp: "whatsapp",
  Instagram: "instagram",
  Facebook: "facebook",
  TikTok: "tiktok",
  LinkedIn: "linkedin",
  GitHub: "github",
  Website: "website",
} as const;
export type ContactKind = (typeof ContactKind)[keyof typeof ContactKind];
export const contactKindSchema = z.enum(ContactKind);

/** Display order of {@link ContactKind} values. */
export const CONTACT_KINDS: readonly ContactKind[] = Object.values(ContactKind);

/** Spanish label shown next to each contact. */
export const CONTACT_LABELS = {
  email: "Correo",
  phone: "Teléfono",
  whatsapp: "WhatsApp",
  instagram: "Instagram",
  facebook: "Facebook",
  tiktok: "TikTok",
  linkedin: "LinkedIn",
  github: "GitHub",
  website: "Sitio web",
} as const satisfies Record<ContactKind, string>;

/** Social networks stored as handles (each has a column and a CHECK). */
export const HandleNetwork = {
  Instagram: "instagram",
  Facebook: "facebook",
  TikTok: "tiktok",
  LinkedIn: "linkedin",
  GitHub: "github",
} as const;
export type HandleNetwork = (typeof HandleNetwork)[keyof typeof HandleNetwork];

/** A handle rule: a regex source valid in **both** JavaScript and Postgres ARE, plus a max length. */
export interface HandleRule {
  /** Anchored pattern. ASCII only, no backslashes, no flags (case-sensitive in both engines). */
  pattern: string;
  /** Max characters (also a `char_length` CHECK). */
  maxLength: number;
}

/**
 * Allowed handle charset/length per network. **Single source of truth**: the
 * zod validators below and the `profiles_<network>_check` CHECKs in the Drizzle
 * schema (and so migration 0004) are generated from these strings. Changing a
 * pattern therefore needs a migration.
 *
 * - Instagram: 1–30 of `A–Z a–z 0–9 . _`, not starting or ending with `.`.
 * - Facebook: 5–50 of `A–Z a–z 0–9 .`, starting with a letter or digit.
 * - TikTok: 2–24 of `A–Z a–z 0–9 . _`, not starting or ending with `.`.
 * - LinkedIn (`/in/<handle>`): 3–100 of `A–Z a–z 0–9 -`, no leading or trailing `-`.
 * - GitHub: 1–39 of `A–Z a–z 0–9 -`, single hyphens only, no leading or trailing `-`.
 *
 * None of them allows `/`, `%`, `@`, `:`, `?`, `#`, whitespace or non-ASCII,
 * so a handle can never change the host or path of its template URL.
 */
export const CONTACT_HANDLE_RULES = {
  instagram: {
    pattern: "^[A-Za-z0-9_](?:[A-Za-z0-9._]{0,28}[A-Za-z0-9_])?$",
    maxLength: 30,
  },
  facebook: { pattern: "^[A-Za-z0-9][A-Za-z0-9.]{4,49}$", maxLength: 50 },
  tiktok: {
    pattern: "^[A-Za-z0-9_][A-Za-z0-9._]{0,22}[A-Za-z0-9_]$",
    maxLength: 24,
  },
  linkedin: {
    pattern: "^[A-Za-z0-9][A-Za-z0-9-]{1,98}[A-Za-z0-9]$",
    maxLength: 100,
  },
  github: { pattern: "^[A-Za-z0-9](?:-?[A-Za-z0-9]){0,38}$", maxLength: 39 },
} as const satisfies Record<HandleNetwork, HandleRule>;

/** E.164: `+`, a non-zero country digit, then 6–14 more digits (7–15 in total). Also the `profiles_whatsapp_check`. */
export const E164_PATTERN = "^[+][1-9][0-9]{6,14}$";
/** Max stored length of an E.164 number (`+` and 15 digits). */
export const E164_MAX_LENGTH = 16;
/** Max length of `profiles.website` (also its CHECK). */
export const CONTACT_WEBSITE_MAX_LENGTH = 200;

/** Default country calling code for numbers typed without one (México). */
export const DEFAULT_PHONE_COUNTRY_CODE = "52";

const handleRegex = Object.fromEntries(
  Object.entries(CONTACT_HANDLE_RULES).map(([network, rule]) => [
    network,
    new RegExp(rule.pattern),
  ]),
) as Record<HandleNetwork, RegExp>; // built from the keys of CONTACT_HANDLE_RULES, which is exactly Record<HandleNetwork, …>
const e164Regex = new RegExp(E164_PATTERN);

/**
 * True when `value` is a valid stored handle for `network` (exact match, no
 * normalization). Used by the server-side card builder to fail closed.
 */
export function isValidHandle(network: HandleNetwork, value: string): boolean {
  return (
    value.length <= CONTACT_HANDLE_RULES[network].maxLength &&
    handleRegex[network].test(value)
  );
}

/** True when `value` is a stored E.164 number (`+5215512345678`). */
export function isE164(value: string): boolean {
  return value.length <= E164_MAX_LENGTH && e164Regex.test(value);
}

/* -------------------------------------------------------------------------- */
/* Phone normalizer                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Normalizes a phone number as typed by family members to E.164, or returns
 * `null` when it cannot be read unambiguously.
 *
 * - Separators (spaces, `( ) - .`) are ignored; any other character is invalid.
 * - `+<digits>` or `00<digits>`: already international; 7–15 digits, first not 0.
 * - 10 digits: a local Mexican number (`DEFAULT_PHONE_COUNTRY_CODE` = 52) → `+52…`.
 * - 12 digits starting with `52`: Mexican without the `+`.
 * - 13 digits starting with `521`: the pre-2020 Mexican mobile prefix; the `1`
 *   is dropped (`+52` + 10 digits), which is how WhatsApp expects it today.
 * - Anything else (e.g. 11 digits without `+`) is ambiguous → `null`.
 *
 * @param input - Raw text.
 * @param defaultCountryCode - Calling code for 10-digit local numbers (digits only).
 * @returns The E.164 string, or `null`.
 */
export function normalizePhoneE164(
  input: string,
  defaultCountryCode: string = DEFAULT_PHONE_COUNTRY_CODE,
): string | null {
  const trimmed = input.trim();
  if (trimmed.length === 0 || trimmed.length > 30) return null;
  if (!/^\+?[0-9 ().-]+$/.test(trimmed)) return null;
  const digits = trimmed.replace(/[^0-9]/g, "");
  let candidate: string;
  if (trimmed.startsWith("+")) {
    candidate = digits;
  } else if (digits.startsWith("00")) {
    candidate = digits.slice(2);
  } else if (digits.length === 10) {
    candidate = `${defaultCountryCode}${digits}`;
  } else if (
    (digits.length === 12 && digits.startsWith("52")) ||
    (digits.length === 13 && digits.startsWith("521"))
  ) {
    candidate = digits;
  } else {
    return null;
  }
  // The pre-2020 Mexican mobile prefix (`+52 1 55…`): drop the `1`.
  if (candidate.length === 13 && candidate.startsWith("521"))
    candidate = `52${candidate.slice(3)}`;
  const e164 = `+${candidate}`;
  return isE164(e164) ? e164 : null;
}

/**
 * Phone input normalized to E.164 (`+52` for 10-digit local numbers). Blank or
 * `null` → `null`. Replaces the free-form `phoneSchema` for contact fields;
 * existing `profiles.phone` values are backfilled by a later WP.
 */
export const e164PhoneSchema: z.ZodType<string | null, string | null> = z
  .string()
  .trim()
  .max(30, { error: "Teléfono inválido." })
  .nullable()
  .transform((value, ctx) => {
    if (value === null || value === "") return null;
    const e164 = normalizePhoneE164(value);
    if (e164 === null) {
      ctx.addIssue({
        code: "custom",
        message: "Teléfono inválido.",
      });
      return z.NEVER;
    }
    return e164;
  });

/* -------------------------------------------------------------------------- */
/* Handle and website inputs                                                   */
/* -------------------------------------------------------------------------- */

const HANDLE_ERRORS = {
  instagram:
    "Usuario de Instagram inválido (letras, números, punto y guion bajo; máximo 30).",
  facebook:
    "Usuario de Facebook inválido (letras, números y punto; de 5 a 50).",
  tiktok:
    "Usuario de TikTok inválido (letras, números, punto y guion bajo; de 2 a 24).",
  linkedin:
    "Usuario de LinkedIn inválido (lo que va después de linkedin.com/in/; letras, números y guiones).",
  github: "Usuario de GitHub inválido (letras, números y guiones; máximo 39).",
} as const satisfies Record<HandleNetwork, string>;

/**
 * Nullable handle input for `network`: trimmed, one leading `@` removed,
 * blank → `null`, then matched exactly against {@link CONTACT_HANDLE_RULES}
 * (no other rewriting: a pasted URL is rejected, not parsed).
 *
 * @param network - The social network.
 */
export function handleInputSchema(
  network: HandleNetwork,
): z.ZodType<string | null, string | null> {
  return z
    .string()
    .trim()
    .max(CONTACT_HANDLE_RULES[network].maxLength + 1, {
      error: HANDLE_ERRORS[network],
    })
    .nullable()
    .transform((value, ctx) => {
      if (value === null) return null;
      const handle = value.startsWith("@") ? value.slice(1) : value;
      if (handle === "") return null;
      if (!isValidHandle(network, handle)) {
        ctx.addIssue({ code: "custom", message: HANDLE_ERRORS[network] });
        return z.NEVER;
      }
      return handle;
    });
}

/**
 * Personal website: blank → `null`; otherwise the canonical `https://` href
 * (no userinfo, dotted host, ≤ {@link CONTACT_WEBSITE_MAX_LENGTH}). Matches the
 * `profiles_website_check` CHECK.
 */
export const contactWebsiteSchema: z.ZodType<string | null, string | null> = z
  .string()
  .trim()
  .max(CONTACT_WEBSITE_MAX_LENGTH, {
    error: `El sitio web admite como máximo ${CONTACT_WEBSITE_MAX_LENGTH} caracteres.`,
  })
  .nullable()
  .transform((value, ctx) => {
    if (value === null || value === "") return null;
    const href = canonicalHttpsUrl(value);
    if (href === null || href.length > CONTACT_WEBSITE_MAX_LENGTH) {
      ctx.addIssue({
        code: "custom",
        message: "El sitio web debe ser una dirección https:// válida.",
      });
      return z.NEVER;
    }
    return href;
  });

/* -------------------------------------------------------------------------- */
/* Visibility                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * "Mostrar a la familia" per contact. Read model: every kind is present.
 *
 * Storage (WP-4.0 decision): `email` and `phone` come from the existing
 * `profiles.show_email` / `show_phone` columns, which stay the source of truth
 * (as does `show_city`). The other seven live in `profiles.contact_visibility`
 * jsonb (keys {@link STORED_CONTACT_VISIBILITY_KEYS}; a missing key = hidden).
 */
export type ContactVisibility = Record<ContactKind, boolean>;

export const contactVisibilitySchema = z.object({
  email: z.boolean(),
  phone: z.boolean(),
  whatsapp: z.boolean(),
  instagram: z.boolean(),
  facebook: z.boolean(),
  tiktok: z.boolean(),
  linkedin: z.boolean(),
  github: z.boolean(),
  website: z.boolean(),
}) satisfies z.ZodType<ContactVisibility>;

/** Keys allowed in `profiles.contact_visibility` (also its CHECK). `email`/`phone` are columns. */
export const STORED_CONTACT_VISIBILITY_KEYS = [
  ContactKind.WhatsApp,
  ContactKind.Instagram,
  ContactKind.Facebook,
  ContactKind.TikTok,
  ContactKind.LinkedIn,
  ContactKind.GitHub,
  ContactKind.Website,
] as const;
export type StoredContactVisibilityKey =
  (typeof STORED_CONTACT_VISIBILITY_KEYS)[number];
/** Shape of `profiles.contact_visibility`. */
export type StoredContactVisibility = Partial<
  Record<StoredContactVisibilityKey, boolean>
>;

/**
 * Builds the read-model {@link ContactVisibility} from the stored columns.
 * Anything that is not literally `true` is hidden (fail closed).
 *
 * @param showEmail - `profiles.show_email`.
 * @param showPhone - `profiles.show_phone`.
 * @param stored - `profiles.contact_visibility` (untrusted jsonb).
 */
export function toContactVisibility(
  showEmail: boolean,
  showPhone: boolean,
  stored: unknown,
): ContactVisibility {
  const map: Record<string, unknown> =
    typeof stored === "object" && stored !== null && !Array.isArray(stored)
      ? { ...stored }
      : {};
  const flag = (key: StoredContactVisibilityKey): boolean => map[key] === true;
  return {
    email: showEmail === true,
    phone: showPhone === true,
    whatsapp: flag("whatsapp"),
    instagram: flag("instagram"),
    facebook: flag("facebook"),
    tiktok: flag("tiktok"),
    linkedin: flag("linkedin"),
    github: flag("github"),
    website: flag("website"),
  };
}

/** Visibility patch: send only the switches that change; at least one when present (`{}` is a no-op → 400). */
export const contactVisibilityInputSchema = z
  .strictObject({
    email: z.boolean(),
    phone: z.boolean(),
    whatsapp: z.boolean(),
    instagram: z.boolean(),
    facebook: z.boolean(),
    tiktok: z.boolean(),
    linkedin: z.boolean(),
    github: z.boolean(),
    website: z.boolean(),
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, {
    error: "Indica al menos un contacto que mostrar u ocultar.",
  });
export type ContactVisibilityInput = z.infer<
  typeof contactVisibilityInputSchema
>;

/* -------------------------------------------------------------------------- */
/* Own contacts (edit)                                                         */
/* -------------------------------------------------------------------------- */

/** The caller's own stored contacts (beyond `email`/`phone`, already on `OwnProfile`). */
export interface OwnContacts {
  /** E.164, e.g. `+525512345678`. */
  whatsapp: string | null;
  instagram: string | null;
  facebook: string | null;
  tiktok: string | null;
  linkedin: string | null;
  github: string | null;
  /** Canonical `https://` href. */
  website: string | null;
  visibility: ContactVisibility;
}

export const ownContactsSchema = z.object({
  whatsapp: z.string().max(E164_MAX_LENGTH).nullable(),
  instagram: z
    .string()
    .max(CONTACT_HANDLE_RULES.instagram.maxLength)
    .nullable(),
  facebook: z.string().max(CONTACT_HANDLE_RULES.facebook.maxLength).nullable(),
  tiktok: z.string().max(CONTACT_HANDLE_RULES.tiktok.maxLength).nullable(),
  linkedin: z.string().max(CONTACT_HANDLE_RULES.linkedin.maxLength).nullable(),
  github: z.string().max(CONTACT_HANDLE_RULES.github.maxLength).nullable(),
  website: z.string().max(CONTACT_WEBSITE_MAX_LENGTH).nullable(),
  visibility: contactVisibilitySchema,
}) satisfies z.ZodType<OwnContacts>;

/**
 * `PATCH /api/profile/me/contacts` (WP-4.4): the **only** path the web uses for
 * contacts, including `phone`. Send only what changes; blank or `null` clears.
 * Strict: unknown keys are a 400. `phone` and `whatsapp` are normalized to
 * E.164; handles drop one leading `@`; `website` is canonical https.
 * `visibility.email`/`phone` write `show_email`/`show_phone`; the rest merge
 * into `contact_visibility`. WhatsApp is stored exactly as sent (`null` =
 * none): the web pre-fills it from the phone, the server never infers it.
 */
export const updateContactsInputSchema = z
  .strictObject({
    phone: e164PhoneSchema,
    whatsapp: e164PhoneSchema,
    instagram: handleInputSchema("instagram"),
    facebook: handleInputSchema("facebook"),
    tiktok: handleInputSchema("tiktok"),
    linkedin: handleInputSchema("linkedin"),
    github: handleInputSchema("github"),
    website: contactWebsiteSchema,
    visibility: contactVisibilityInputSchema,
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, {
    error: "No hay cambios que guardar.",
  });
export type UpdateContactsInput = z.infer<typeof updateContactsInputSchema>;
export type UpdateContactsRequest = z.input<typeof updateContactsInputSchema>;

/* -------------------------------------------------------------------------- */
/* Contact card (read model)                                                   */
/* -------------------------------------------------------------------------- */

/** One tappable contact. `href` is always built server-side by {@link buildContactCard}. */
export interface ContactItem {
  kind: ContactKind;
  /** Spanish label ({@link CONTACT_LABELS}). */
  label: string;
  /** `https://…` from a fixed per-kind template, `mailto:` or `tel:`. Render as-is. */
  href: string;
  /** Text to show (handle with `@`, E.164 number, email, website host/path). */
  display: string;
}

/** A member's visible contacts, in {@link CONTACT_KINDS} order. Empty when nothing is visible. */
export type ContactCard = ContactItem[];

/** Defense in depth: a response `href` must use one of the allowed schemes. */
const CONTACT_HREF_PATTERN =
  /^(?:https:\/\/[^\s]+|mailto:[^\s]+|tel:\+[0-9]+)$/;

export const contactItemSchema = z.object({
  kind: contactKindSchema,
  label: z.string().max(40),
  href: z.string().max(300).regex(CONTACT_HREF_PATTERN),
  display: z.string().max(260),
}) satisfies z.ZodType<ContactItem>;

/** Max items in a card (one per kind). */
export const CONTACT_CARD_MAX = CONTACT_KINDS.length;
export const contactCardSchema = z
  .array(contactItemSchema)
  .max(CONTACT_CARD_MAX) satisfies z.ZodType<ContactCard>;

/** Stored contact values the card is built from (a profile row). */
export interface ContactSource {
  email: string | null;
  phone: string | null;
  whatsapp: string | null;
  instagram: string | null;
  facebook: string | null;
  tiktok: string | null;
  linkedin: string | null;
  github: string | null;
  website: string | null;
}

/** Fixed link template per handle network. The handle is already charset-checked. */
const HANDLE_TEMPLATES = {
  instagram: (handle: string) => ({
    href: `https://instagram.com/${handle}`,
    display: `@${handle}`,
  }),
  facebook: (handle: string) => ({
    href: `https://www.facebook.com/${handle}`,
    display: handle,
  }),
  tiktok: (handle: string) => ({
    href: `https://www.tiktok.com/@${handle}`,
    display: `@${handle}`,
  }),
  linkedin: (handle: string) => ({
    href: `https://www.linkedin.com/in/${handle}`,
    display: handle,
  }),
  github: (handle: string) => ({
    href: `https://github.com/${handle}`,
    display: handle,
  }),
} as const satisfies Record<
  HandleNetwork,
  (handle: string) => { href: string; display: string }
>;

function emailItem(
  value: string,
): Pick<ContactItem, "href" | "display"> | null {
  const parsed = emailSchema.safeParse(value);
  if (!parsed.success || parsed.data !== value.trim().toLowerCase())
    return null;
  return { href: `mailto:${parsed.data}`, display: parsed.data };
}

function phoneItem(
  value: string,
): Pick<ContactItem, "href" | "display"> | null {
  // Security L1: only an already-valid E.164 value becomes a `tel:` link.
  // Legacy free-form `profiles.phone` values are dropped (never guessed as +52:
  // a US 10-digit number would dial Mexico) until the E.164 backfill. The +52
  // default applies to input normalization only.
  return isE164(value) ? { href: `tel:${value}`, display: value } : null;
}

function whatsappItem(
  value: string,
): Pick<ContactItem, "href" | "display"> | null {
  if (!isE164(value)) return null;
  return { href: `https://wa.me/${value.slice(1)}`, display: value };
}

function websiteItem(
  value: string,
): Pick<ContactItem, "href" | "display"> | null {
  const href = canonicalHttpsUrl(value);
  if (href === null || href.length > CONTACT_WEBSITE_MAX_LENGTH) return null;
  // `URL.host` is punycode for IDN hosts, so a lookalike host shows as `xn--…`.
  const url = new URL(href);
  const path = url.pathname === "/" ? "" : url.pathname;
  return { href, display: `${url.host}${path}`.slice(0, 260) };
}

function itemFor(
  kind: ContactKind,
  value: string,
): Pick<ContactItem, "href" | "display"> | null {
  switch (kind) {
    case "email":
      return emailItem(value);
    case "phone":
      return phoneItem(value);
    case "whatsapp":
      return whatsappItem(value);
    case "website":
      return websiteItem(value);
    default:
      return isValidHandle(kind, value) ? HANDLE_TEMPLATES[kind](value) : null;
  }
}

/**
 * Builds the member-facing {@link ContactCard}: one item per contact that has
 * a value **and** is switched on in `visibility`, in {@link CONTACT_KINDS}
 * order. Every value is re-validated against its rule; a value that fails
 * (corrupt row, or a legacy phone not yet stored as E.164) is silently left
 * out rather than linked; nothing is normalized or guessed at read time. `href` comes only from the fixed templates:
 *
 * | kind | href |
 * |---|---|
 * | email | `mailto:<email>` |
 * | phone | `tel:<E.164>` |
 * | whatsapp | `https://wa.me/<digits>` |
 * | instagram | `https://instagram.com/<handle>` |
 * | facebook | `https://www.facebook.com/<handle>` |
 * | tiktok | `https://www.tiktok.com/@<handle>` |
 * | linkedin | `https://www.linkedin.com/in/<handle>` |
 * | github | `https://github.com/<handle>` |
 * | website | the canonical `https://` href |
 *
 * The caller decides *whether* the viewer may see contacts at all (verified
 * member, account listed and active); this only applies the per-field switches.
 *
 * @param source - Stored contact values.
 * @param visibility - Per-field switches (see {@link toContactVisibility}).
 * @returns The visible contacts (possibly empty).
 */
export function buildContactCard(
  source: ContactSource,
  visibility: ContactVisibility,
): ContactCard {
  const card: ContactCard = [];
  for (const kind of CONTACT_KINDS) {
    if (visibility[kind] !== true) continue;
    const value = source[kind];
    if (typeof value !== "string" || value.length === 0) continue;
    const item = itemFor(kind, value);
    if (item !== null)
      card.push({ kind, label: CONTACT_LABELS[kind], ...item });
  }
  return card;
}
