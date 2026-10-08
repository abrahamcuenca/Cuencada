import { describe, expect, it } from "vitest";
import {
  CONTACT_HANDLE_RULES,
  type ContactSource,
  type ContactVisibility,
  buildContactCard,
  contactCardSchema,
  contactVisibilitySchema,
  e164PhoneSchema,
  handleInputSchema,
  isE164,
  isValidHandle,
  normalizePhoneE164,
  toContactVisibility,
  updateContactsInputSchema,
} from "./contacts.js";
import { contactWebsiteSchema } from "./contacts.js";
import { directoryEntrySchema, ownProfileSchema } from "./profile.js";

const NONE: ContactSource = {
  email: null,
  phone: null,
  whatsapp: null,
  instagram: null,
  facebook: null,
  tiktok: null,
  linkedin: null,
  github: null,
  website: null,
};

const ALL_ON: ContactVisibility = {
  email: true,
  phone: true,
  whatsapp: true,
  instagram: true,
  facebook: true,
  tiktok: true,
  linkedin: true,
  github: true,
  website: true,
};

const ALL_OFF: ContactVisibility = contactVisibilitySchema.parse(
  Object.fromEntries(Object.keys(ALL_ON).map((key) => [key, false])),
);

const FULL: ContactSource = {
  email: "ana@example.com",
  phone: "+525550100101",
  whatsapp: "+525550100101",
  instagram: "ana.morales",
  facebook: "ana.morales.vega",
  tiktok: "ana_morales",
  linkedin: "ana-morales-vega",
  github: "ana-morales",
  website: "https://example.com/ana",
};

/** Values a hostile or corrupted row might hold. Every one must be dropped, never linked. */
const INJECTIONS = [
  "javascript:alert(1)",
  "JaVaScRiPt:alert(1)",
  "data:text/html,<script>alert(1)</script>",
  "ana/../../evil",
  "ana%2F..%2Fevil",
  "ana%2fevil",
  "..",
  "@evil.com",
  "ana@evil.com",
  "evil.com@ana",
  "ana?next=https://evil.com",
  "ana#frag",
  "аna", // Cyrillic а
  "ana\u200B", // zero-width space
  "ana\u202Eevil", // RTL override
  "ana\nSet-Cookie: x",
  "ana\r\n",
  " ana",
  "ana ",
  "ana\tx",
  "//evil.com",
  "https://evil.com",
  "<img src=x>",
  'ana"onmouseover=alert(1)',
  "ana'x",
];

describe("CONTACT_HANDLE_RULES", () => {
  it("are anchored, ASCII and backslash-free so JS and Postgres read them alike", () => {
    for (const [network, rule] of Object.entries(CONTACT_HANDLE_RULES)) {
      expect(rule.pattern.startsWith("^"), network).toBe(true);
      expect(rule.pattern.endsWith("$"), network).toBe(true);
      expect(rule.pattern.includes("\\"), network).toBe(false);
      expect(/^[\x20-\x7E]+$/.test(rule.pattern), network).toBe(true);
    }
  });

  it("accepts typical handles and enforces each network's length", () => {
    expect(isValidHandle("instagram", "ana.morales_92")).toBe(true);
    expect(isValidHandle("instagram", "a")).toBe(true);
    expect(isValidHandle("instagram", "x".repeat(30))).toBe(true);
    expect(isValidHandle("instagram", "x".repeat(31))).toBe(false);
    expect(isValidHandle("instagram", ".ana")).toBe(false);
    expect(isValidHandle("instagram", "ana.")).toBe(false);
    expect(isValidHandle("facebook", "ana.morales")).toBe(true);
    expect(isValidHandle("facebook", "anam")).toBe(false);
    expect(isValidHandle("facebook", "x".repeat(50))).toBe(true);
    expect(isValidHandle("facebook", "x".repeat(51))).toBe(false);
    expect(isValidHandle("facebook", "ana_morales")).toBe(false);
    expect(isValidHandle("tiktok", "ab")).toBe(true);
    expect(isValidHandle("tiktok", "a")).toBe(false);
    expect(isValidHandle("tiktok", "x".repeat(25))).toBe(false);
    expect(isValidHandle("tiktok", "ana.")).toBe(false);
    expect(isValidHandle("linkedin", "ana-morales-vega")).toBe(true);
    expect(isValidHandle("linkedin", "ab")).toBe(false);
    expect(isValidHandle("linkedin", "-ana")).toBe(false);
    expect(isValidHandle("linkedin", "x".repeat(101))).toBe(false);
    expect(isValidHandle("github", "a")).toBe(true);
    expect(isValidHandle("github", "ana-morales")).toBe(true);
    expect(isValidHandle("github", "ana--morales")).toBe(false);
    expect(isValidHandle("github", "ana-")).toBe(false);
    expect(isValidHandle("github", "x".repeat(39))).toBe(true);
    expect(isValidHandle("github", "x".repeat(40))).toBe(false);
  });

  it("rejects every injection attempt on every network", () => {
    for (const network of [
      "instagram",
      "facebook",
      "tiktok",
      "linkedin",
      "github",
    ] as const) {
      for (const value of INJECTIONS)
        expect(
          isValidHandle(network, value),
          `${network} ${JSON.stringify(value)}`,
        ).toBe(false);
    }
  });
});

describe("normalizePhoneE164", () => {
  it("reads Mexican local, national and international forms", () => {
    expect(normalizePhoneE164("55 5010 0101")).toBe("+525550100101");
    expect(normalizePhoneE164("(555) 010-0101")).toBe("+525550100101");
    expect(normalizePhoneE164("555.010.0101")).toBe("+525550100101");
    expect(normalizePhoneE164("525550100101")).toBe("+525550100101");
    expect(normalizePhoneE164("+52 55 5010 0101")).toBe("+525550100101");
    expect(normalizePhoneE164("0052 55 5010 0101")).toBe("+525550100101");
  });

  it("drops the old Mexican mobile 1 after 52", () => {
    expect(normalizePhoneE164("+52 1 55 5010 0101")).toBe("+525550100101");
    expect(normalizePhoneE164("5215550100101")).toBe("+525550100101");
  });

  it("keeps other countries when written internationally", () => {
    expect(normalizePhoneE164("+1 (555) 010-0199")).toBe("+15550100199");
    expect(normalizePhoneE164("+34 600 000 000")).toBe("+34600000000");
    expect(normalizePhoneE164("0034 600 000 000")).toBe("+34600000000");
  });

  it("uses another default country for 10-digit numbers when asked", () => {
    expect(normalizePhoneE164("555 010 0199", "1")).toBe("+15550100199");
  });

  it("returns null for ambiguous, short, long or non-numeric input", () => {
    for (const value of [
      "",
      "   ",
      "12345",
      "15550100199", // 11 digits without +: ambiguous
      "555010010", // 9 digits
      "5255501001010", // 13 digits starting 52 but not 521
      "+0 555 010 0101",
      "+1234567890123456",
      "+52 55 5010 0101 ext 2",
      "tel:+525550100101",
      "+52\n5550100101",
      "+52\u201155\u20115010\u20110101", // non-ASCII hyphens
      "５５５０１００１０１", // full-width digits
    ]) {
      expect(normalizePhoneE164(value), JSON.stringify(value)).toBeNull();
    }
  });

  it("only produces values the E.164 CHECK accepts", () => {
    for (const value of [
      "55 5010 0101",
      "+1 555 010 0199",
      "+52 1 55 5010 0101",
      "+1234567",
    ]) {
      const e164 = normalizePhoneE164(value);
      expect(e164 !== null && isE164(e164), value).toBe(true);
    }
  });
});

describe("contact inputs", () => {
  it("e164PhoneSchema normalizes, clears blanks and rejects junk", () => {
    expect(e164PhoneSchema.parse("55 5010 0101")).toBe("+525550100101");
    expect(e164PhoneSchema.parse("")).toBeNull();
    expect(e164PhoneSchema.parse(null)).toBeNull();
    expect(e164PhoneSchema.safeParse("hola").success).toBe(false);
    expect(e164PhoneSchema.safeParse("1".repeat(31)).success).toBe(false);
  });

  it("handleInputSchema strips one @, trims, and never rewrites a URL into a handle", () => {
    const instagram = handleInputSchema("instagram");
    expect(instagram.parse("  @ana.morales ")).toBe("ana.morales");
    expect(instagram.parse("@")).toBeNull();
    expect(instagram.parse("")).toBeNull();
    expect(instagram.safeParse("@@ana").success).toBe(false);
    expect(instagram.safeParse("https://instagram.com/ana").success).toBe(
      false,
    );
    expect(instagram.safeParse("instagram.com/ana").success).toBe(false);
    // Trimming and one leading `@` are the only rewrites: whatever is accepted is a valid stored handle.
    for (const value of INJECTIONS) {
      const parsed = instagram.safeParse(value);
      if (parsed.success)
        expect(
          parsed.data !== null && isValidHandle("instagram", parsed.data),
          JSON.stringify(value),
        ).toBe(true);
    }
    expect(instagram.parse(" ana ")).toBe("ana");
    expect(instagram.parse("@evil.com")).toBe("evil.com"); // a legal Instagram handle; links to instagram.com/evil.com
    for (const value of [
      "javascript:alert(1)",
      "ana/../../evil",
      "ana%2F..%2Fevil",
      "ana@evil.com",
      "ana\nSet-Cookie: x",
      "аna",
    ]) {
      expect(instagram.safeParse(value).success, JSON.stringify(value)).toBe(
        false,
      );
    }
  });

  it("contactWebsiteSchema keeps only canonical https URLs up to 200 characters", () => {
    expect(contactWebsiteSchema.parse("https://Example.com/ana")).toBe(
      "https://example.com/ana",
    );
    expect(contactWebsiteSchema.parse(" ")).toBeNull();
    for (const value of [
      "http://example.com",
      "javascript:alert(1)",
      "https://example.com@evil.com",
      "https://localhost",
      "//evil.com",
    ]) {
      expect(contactWebsiteSchema.safeParse(value).success, value).toBe(false);
    }
    expect(
      contactWebsiteSchema.safeParse(`https://example.com/${"a".repeat(180)}`)
        .success,
    ).toBe(true);
    expect(
      contactWebsiteSchema.safeParse(`https://example.com/${"a".repeat(181)}`)
        .success,
    ).toBe(false);
  });

  it("updateContactsInputSchema is strict and refuses an empty patch", () => {
    expect(
      updateContactsInputSchema.parse({
        whatsapp: "55 5010 0101",
        visibility: { whatsapp: true },
      }),
    ).toEqual({
      whatsapp: "+525550100101",
      visibility: { whatsapp: true },
    });
    expect(updateContactsInputSchema.safeParse({}).success).toBe(false);
    expect(
      updateContactsInputSchema.safeParse({ email: "x@example.com" }).success,
    ).toBe(false);
    expect(
      updateContactsInputSchema.safeParse({ visibility: { city: true } })
        .success,
    ).toBe(false);
    // An empty visibility object is a no-op, alone or alongside other fields.
    expect(updateContactsInputSchema.safeParse({ visibility: {} }).success).toBe(false);
    expect(updateContactsInputSchema.safeParse({ github: "ana", visibility: {} }).success).toBe(false);
    // WhatsApp is stored as sent: nothing is inferred from the phone.
    expect(updateContactsInputSchema.parse({ phone: "55 5010 0101" })).toEqual({ phone: "+525550100101" });
    expect(
      updateContactsInputSchema.safeParse({ visibility: { whatsapp: "true" } })
        .success,
    ).toBe(false);
  });
});

describe("toContactVisibility", () => {
  it("reads email/phone from the columns and the rest from the map, failing closed", () => {
    expect(
      toContactVisibility(true, false, { whatsapp: true, github: false }),
    ).toEqual({
      ...ALL_OFF,
      email: true,
      whatsapp: true,
    });
    expect(
      toContactVisibility(false, false, {
        whatsapp: "yes",
        email: true,
        instagram: 1,
      }),
    ).toEqual(ALL_OFF);
    expect(toContactVisibility(false, true, null)).toEqual({
      ...ALL_OFF,
      phone: true,
    });
    expect(toContactVisibility(false, false, [true])).toEqual(ALL_OFF);
  });
});

describe("buildContactCard", () => {
  it("builds every link from its fixed template, in display order", () => {
    expect(buildContactCard(FULL, ALL_ON)).toEqual([
      {
        kind: "email",
        label: "Correo",
        href: "mailto:ana@example.com",
        display: "ana@example.com",
      },
      {
        kind: "phone",
        label: "Teléfono",
        href: "tel:+525550100101",
        display: "+525550100101",
      },
      {
        kind: "whatsapp",
        label: "WhatsApp",
        href: "https://wa.me/525550100101",
        display: "+525550100101",
      },
      {
        kind: "instagram",
        label: "Instagram",
        href: "https://instagram.com/ana.morales",
        display: "@ana.morales",
      },
      {
        kind: "facebook",
        label: "Facebook",
        href: "https://www.facebook.com/ana.morales.vega",
        display: "ana.morales.vega",
      },
      {
        kind: "tiktok",
        label: "TikTok",
        href: "https://www.tiktok.com/@ana_morales",
        display: "@ana_morales",
      },
      {
        kind: "linkedin",
        label: "LinkedIn",
        href: "https://www.linkedin.com/in/ana-morales-vega",
        display: "ana-morales-vega",
      },
      {
        kind: "github",
        label: "GitHub",
        href: "https://github.com/ana-morales",
        display: "ana-morales",
      },
      {
        kind: "website",
        label: "Sitio web",
        href: "https://example.com/ana",
        display: "example.com/ana",
      },
    ]);
    expect(
      contactCardSchema.safeParse(buildContactCard(FULL, ALL_ON)).success,
    ).toBe(true);
  });

  it("returns nothing when everything is hidden or empty", () => {
    expect(buildContactCard(FULL, ALL_OFF)).toEqual([]);
    expect(buildContactCard(NONE, ALL_ON)).toEqual([]);
    expect(buildContactCard({ ...NONE, instagram: "" }, ALL_ON)).toEqual([]);
  });

  it("honours each switch independently", () => {
    for (const kind of Object.keys(ALL_ON) as (keyof ContactVisibility)[]) {
      // Object.keys of a ContactVisibility literal is exactly its keys.
      const card = buildContactCard(FULL, { ...ALL_OFF, [kind]: true });
      expect(
        card.map((item) => item.kind),
        kind,
      ).toEqual([kind]);
    }
  });

  it("treats anything but literal true as hidden", () => {
    const sloppy = {
      ...ALL_OFF,
      instagram: "true",
      github: 1,
    } as unknown as ContactVisibility; // simulates an untyped caller
    expect(buildContactCard(FULL, sloppy)).toEqual([]);
  });

  it("drops injection attempts in every handle field instead of linking them", () => {
    for (const kind of [
      "instagram",
      "facebook",
      "tiktok",
      "linkedin",
      "github",
    ] as const) {
      for (const value of INJECTIONS) {
        expect(
          buildContactCard({ ...NONE, [kind]: value }, ALL_ON),
          `${kind} ${JSON.stringify(value)}`,
        ).toEqual([]);
      }
    }
  });

  it("drops hostile whatsapp, email and website values", () => {
    for (const value of [
      "javascript:alert(1)",
      "525550100101",
      "+52 55 5010 0101",
      "+525550100101\n",
      "+52555010010x",
      "+0525550100101",
    ]) {
      expect(
        buildContactCard({ ...NONE, whatsapp: value }, ALL_ON),
        value,
      ).toEqual([]);
    }
    for (const value of [
      "ana@example.com?subject=x",
      "ana@example.com\nbcc:x@example.com",
      "javascript:alert(1)",
      "ana",
    ]) {
      expect(
        buildContactCard({ ...NONE, email: value }, ALL_ON),
        value,
      ).toEqual([]);
    }
    for (const value of [
      "javascript:alert(1)",
      "http://example.com",
      "https://example.com@evil.com",
      "https://user:pass@example.com",
      "//evil.com",
      "https://localhost",
      "data:text/html,x",
      `https://example.com/${"a".repeat(181)}`,
    ]) {
      expect(
        buildContactCard({ ...NONE, website: value }, ALL_ON),
        value,
      ).toEqual([]);
    }
  });

  it("canonicalizes websites and shows lookalike hosts as punycode", () => {
    const [item] = buildContactCard(
      { ...NONE, website: "https://ехample.com/" },
      ALL_ON,
    ); // Cyrillic е and х
    expect(item?.href.startsWith("https://xn--")).toBe(true);
    expect(item?.display.startsWith("xn--")).toBe(true);
    const [encoded] = buildContactCard(
      { ...NONE, website: "https://example.com/a%2F..%2Fb" },
      ALL_ON,
    );
    expect(encoded?.href).toBe("https://example.com/a%2F..%2Fb");
    // A backslash `@` trick resolves to the real host, and the display says so.
    const [trick] = buildContactCard(
      { ...NONE, website: "https://evil.com\\@example.com" },
      ALL_ON,
    );
    expect(trick).toMatchObject({
      href: "https://evil.com/@example.com",
      display: "evil.com/@example.com",
    });
  });

  it("links only phones already stored as E.164 and never guesses +52 at read time (Security L1)", () => {
    expect(buildContactCard({ ...NONE, phone: "+525550100101" }, ALL_ON)).toEqual([
      { kind: "phone", label: "Teléfono", href: "tel:+525550100101", display: "+525550100101" },
    ]);
    expect(buildContactCard({ ...NONE, phone: "+15550100199" }, ALL_ON)).toEqual([
      { kind: "phone", label: "Teléfono", href: "tel:+15550100199", display: "+15550100199" },
    ]);
    // Legacy free-form values are dropped, not normalized: a US 10-digit number
    // would otherwise be dialled as Mexican.
    for (const legacy of [
      "555 010 0199", // US 10-digit legacy value
      "(555) 010-0199",
      "55 5010 0101", // Mexican local, still not E.164
      "525550100101",
      "+52 55 5010 0101", // international but with spaces
      "15550100199",
      "llámame",
    ]) {
      expect(buildContactCard({ ...NONE, phone: legacy }, ALL_ON), legacy).toEqual([]);
    }
    // The +52 default still applies when *normalizing input*.
    expect(normalizePhoneE164("555 010 0199")).toBe("+525550100199");
  });

  it("only ever emits https, mailto or tel links", () => {
    const card = buildContactCard(FULL, ALL_ON);
    for (const item of card)
      expect(/^(https:\/\/|mailto:|tel:\+)/.test(item.href), item.href).toBe(
        true,
      );
  });
});

describe("contactCardSchema", () => {
  it("rejects a hand-built item with a dangerous href (defense in depth)", () => {
    const item = { kind: "website", label: "Sitio web", display: "x" };
    for (const href of [
      "javascript:alert(1)",
      "http://example.com",
      "data:x",
      "tel:555",
      "https://exa mple.com",
      "mailto:a b@c.d",
    ]) {
      expect(
        contactCardSchema.safeParse([{ ...item, href }]).success,
        href,
      ).toBe(false);
    }
  });
});

describe("profile response compatibility", () => {
  const base = {
    userId: "1b2c3d4e-5f60-4b7c-9d8e-0f1a2b3c4d5e",
    personId: null,
    displayName: "Ana",
    fullName: "Ana",
    familyBranch: null,
    avatarUrl: null,
    bio: null,
  };

  it("directory entries without contacts (older servers) still parse; with contacts they validate", () => {
    expect(directoryEntrySchema.safeParse(base).success).toBe(true);
    expect(
      directoryEntrySchema.parse({
        ...base,
        contacts: buildContactCard(FULL, ALL_ON),
      }).contacts,
    ).toHaveLength(9);
    expect(
      directoryEntrySchema.safeParse({ ...base, contacts: null }).success,
    ).toBe(false);
  });

  it("own profiles without contacts still parse", () => {
    const own = {
      userId: base.userId,
      personId: null,
      email: "ana@example.com",
      displayName: "Ana",
      fullName: "Ana",
      familyBranch: null,
      city: null,
      phone: null,
      bio: null,
      avatarUrl: null,
      visibility: {
        showEmail: false,
        showPhone: false,
        showCity: false,
        listedInDirectory: true,
      },
      updatedAt: "2026-10-07T12:00:00Z",
    };
    expect(ownProfileSchema.safeParse(own).success).toBe(true);
    const contacts = { ...NONE, visibility: ALL_OFF };
    const { email: _email, phone: _phone, ...ownContacts } = contacts;
    expect(
      ownProfileSchema.parse({ ...own, contacts: ownContacts }).contacts
        ?.visibility,
    ).toEqual(ALL_OFF);
  });
});
