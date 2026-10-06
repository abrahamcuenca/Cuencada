import { describe, expect, it } from "vitest";
import {
  ValidationIssueCode,
  apiErrorSchema,
  assetUrlSchema,
  cursorQuerySchema,
  displayTextSchema,
  httpsUrlSchema,
  queryBooleanSchema,
  stripUnsafeChars,
  timezoneSchema
} from "./common.js";

describe("timezoneSchema", () => {
  it("accepts real IANA zones and UTC", () => {
    for (const zone of ["America/Merida", "America/Mexico_City", "America/Argentina/Buenos_Aires", "UTC"]) {
      expect(timezoneSchema.safeParse(zone).success).toBe(true);
    }
  });

  it("rejects well-shaped but unknown zones", () => {
    expect(timezoneSchema.safeParse("Foo/Bar").success).toBe(false);
    expect(timezoneSchema.safeParse("America/Atlantis").success).toBe(false);
  });

  it("rejects traversal and junk", () => {
    expect(timezoneSchema.safeParse("../etc/passwd").success).toBe(false);
    expect(timezoneSchema.safeParse("").success).toBe(false);
  });
});

describe("httpsUrlSchema", () => {
  it("returns the canonical href", () => {
    expect(httpsUrlSchema.parse(" https://Example.COM/a b ")).toBe("https://example.com/a%20b");
    expect(httpsUrlSchema.parse("https://chat.whatsapp.com/abc?x=1")).toBe("https://chat.whatsapp.com/abc?x=1");
  });

  it("rejects non-https schemes", () => {
    for (const value of ["http://example.com", "javascript:alert(1)", "data:text/html,x", "ftp://example.com"]) {
      expect(httpsUrlSchema.safeParse(value).success).toBe(false);
    }
  });

  it("rejects malformed https forms, userinfo and single-label hosts", () => {
    for (const value of ["https:evil.com", "https:/\\evil.com", "https://u:p@x.com", "https://cuencada.com@evil.com", "https://x", "https://localhost/a"]) {
      expect(httpsUrlSchema.safeParse(value).success).toBe(false);
    }
  });
});

describe("assetUrlSchema", () => {
  it("accepts site paths under images and canciones", () => {
    expect(assetUrlSchema.safeParse("/canciones/Cancion_Oficial.mp3").success).toBe(true);
  });

  it("rejects traversal and double slashes", () => {
    expect(assetUrlSchema.safeParse("/images/../x").success).toBe(false);
    expect(assetUrlSchema.safeParse("/images//evil.com").success).toBe(false);
  });
});

describe("queryBooleanSchema", () => {
  it("maps wire strings and passes booleans through", () => {
    expect(queryBooleanSchema.parse("true")).toBe(true);
    expect(queryBooleanSchema.parse("false")).toBe(false);
    expect(queryBooleanSchema.parse(false)).toBe(false);
  });

  it("rejects other truthy-looking values", () => {
    for (const value of ["1", "yes", "", "TRUE", 1]) {
      expect(queryBooleanSchema.safeParse(value).success).toBe(false);
    }
  });
});

describe("cursorQuerySchema", () => {
  it("coerces limit from the query string and applies the default", () => {
    expect(cursorQuerySchema.parse({ limit: "50" })).toEqual({ limit: 50 });
    expect(cursorQuerySchema.parse({})).toEqual({ limit: 20 });
    expect(cursorQuerySchema.safeParse({ limit: "101" }).success).toBe(false);
  });
});

describe("displayTextSchema", () => {
  const name = displayTextSchema(80);

  it("normalizes to NFC and trims", () => {
    expect(name.parse(" Jose\u0301 ")).toBe("Jos\u00E9");
  });

  it("rejects bidi overrides, isolates, zero-width and BOM characters", () => {
    for (const value of ["\u202E", "Ana\u202Egpj", "\u200B", "Ana\u2066x\u2069", "An\uFEFFa", "A\u200Dna"]) {
      expect(name.safeParse(value).success).toBe(false);
    }
  });
});

describe("stripUnsafeChars", () => {
  it("removes bidi controls but keeps emoji ZWJ sequences", () => {
    const family = "👨\u200D👩\u200D👧";
    expect(stripUnsafeChars(`hola\u202E ${family}`)).toBe(`hola ${family}`);
  });
});

describe("apiErrorSchema", () => {
  it("rejects more than 100 details", () => {
    const details = Array.from({ length: 101 }, (_, index) => ({ path: `lines.${index}`, message: "x" }));
    expect(apiErrorSchema.safeParse({ error: { code: "VALIDATION", message: "x", details } }).success).toBe(false);
  });

  it("keeps a known detail code", () => {
    const detail = { path: "password", message: "x", code: ValidationIssueCode.PASSWORD_BREACHED };
    const parsed = apiErrorSchema.parse({ error: { code: "VALIDATION", message: "x", details: [detail] } });
    expect(parsed.error.details).toEqual([detail]);
  });

  it("parses an unknown detail code (forward compatibility) but bounds its length", () => {
    const future = { path: "password", message: "Mensaje nuevo.", code: "PASSWORD_TOO_SIMILAR_TO_EMAIL" };
    const parsed = apiErrorSchema.parse({ error: { code: "VALIDATION", message: "x", details: [future] } });
    expect(parsed.error.details).toEqual([future]);
    const huge = { error: { code: "VALIDATION", message: "x", details: [{ ...future, code: "X".repeat(65) }] } };
    expect(apiErrorSchema.safeParse(huge).success).toBe(false);
  });
});
