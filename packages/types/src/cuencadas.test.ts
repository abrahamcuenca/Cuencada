import { describe, expect, it } from "vitest";
import { API_ERROR_DETAILS_MAX, apiErrorSchema } from "./common.js";
import {
  adminAnnouncementQuerySchema,
  CUENCADA_DATES_TOGETHER_MESSAGE,
  CuencadaStatus,
  cuencadaSummarySchema,
  createAnnouncementInputSchema,
  createCuencadaInputSchema,
  createItineraryItemInputSchema,
  createLocationInputSchema,
  dailyMessageLineSchema,
  dailyMessagesImportInputSchema,
  hasDates,
  parseDailyMessagesText,
  reorderInputSchema,
  updateAnnouncementInputSchema,
  updateCuencadaInputSchema,
  updateItineraryItemInputSchema,
  updateLocationInputSchema
} from "./cuencadas.js";

describe("dailyMessageLineSchema", () => {
  it("parses a legacy mensajes.txt line", () => {
    expect(dailyMessageLineSchema.parse("2026-09-13|🎉 ¡Hoy comienza nuestra CUENCADA 2026! Bienvenidos.")).toEqual({
      date: "2026-09-13",
      message: "🎉 ¡Hoy comienza nuestra CUENCADA 2026! Bienvenidos."
    });
  });

  it("splits on the first pipe only", () => {
    expect(dailyMessageLineSchema.parse("2026-09-14|uno | dos").message).toBe("uno | dos");
  });

  it("rejects a line without a separator", () => {
    const result = dailyMessageLineSchema.safeParse("2026-09-14 hola");
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain("AAAA-MM-DD|mensaje");
  });

  it("rejects an invalid date and an empty message", () => {
    expect(dailyMessageLineSchema.safeParse("2026-13-40|hola").success).toBe(false);
    expect(dailyMessageLineSchema.safeParse("2026-09-14|   ").success).toBe(false);
  });

  it("rejects messages over 1000 characters", () => {
    expect(dailyMessageLineSchema.safeParse(`2026-09-14|${"a".repeat(1001)}`).success).toBe(false);
  });
});

describe("parseDailyMessagesText", () => {
  it("parses a file with BOM, CRLF, blank lines and comments", () => {
    const text = "\uFEFF# mensajes\r\n2026-09-10|uno\r\n\r\n2026-09-11|dos\n";
    expect(parseDailyMessagesText(text)).toEqual({
      errorCount: 0,
      entries: [
        { date: "2026-09-10", message: "uno" },
        { date: "2026-09-11", message: "dos" }
      ],
      errors: []
    });
  });

  it("reports invalid lines with 1-based line numbers", () => {
    const result = parseDailyMessagesText("2026-09-10|uno\nbasura\n2026-09-12|tres");
    expect(result.entries).toHaveLength(2);
    expect(result.errors).toEqual([{ path: "lines.2", message: expect.any(String) }]);
  });

  it("reports duplicate dates", () => {
    const result = parseDailyMessagesText("2026-09-10|uno\n2026-09-10|otra vez");
    expect(result.entries).toHaveLength(1);
    expect(result.errors[0]?.path).toBe("lines.2");
    expect(result.errors[0]?.message).toContain("línea 1");
  });

  it("returns nothing for an empty file", () => {
    expect(parseDailyMessagesText("")).toEqual({ entries: [], errors: [], errorCount: 0 });
  });
});

describe("createCuencadaInputSchema", () => {
  const base = {
    year: 2028,
    title: "Cuencada 2028",
    startsAt: "2028-07-01T00:00:00-06:00",
    endsAt: "2028-07-05T23:59:59-06:00",
    city: "Oaxaca",
    state: "Oaxaca",
    description: "Próxima reunión."
  };

  it("applies defaults", () => {
    const parsed = createCuencadaInputSchema.parse(base);
    expect(parsed.timezone).toBe("America/Merida");
    expect(parsed.themeColor).toBe("#0b5e55");
    expect(parsed.isPublished).toBe(false);
  });

  it("rejects endsAt before startsAt", () => {
    expect(createCuencadaInputSchema.safeParse({ ...base, endsAt: "2028-06-01T00:00:00-06:00" }).success).toBe(false);
  });

  it("rejects non-https links", () => {
    expect(createCuencadaInputSchema.safeParse({ ...base, whatsappUrl: "javascript:alert(1)" }).success).toBe(false);
    expect(createCuencadaInputSchema.safeParse({ ...base, songUrl: "http://example.com/a.mp3" }).success).toBe(false);
  });

  it("accepts a site-relative hero image but rejects path traversal", () => {
    expect(createCuencadaInputSchema.safeParse({ ...base, heroImageUrl: "/images/Logo_Cuencada2026.jpg" }).success).toBe(true);
    expect(createCuencadaInputSchema.safeParse({ ...base, heroImageUrl: "/images/../secret" }).success).toBe(false);
  });
});

describe("createCuencadaInputSchema for an announced edition", () => {
  const announced = { year: 2027, title: "Cuencada 2027", description: "Fecha y lugar por anunciar." };

  it("accepts omitted dates and place and defaults them to null", () => {
    const parsed = createCuencadaInputSchema.parse(announced);
    expect(parsed).toMatchObject({ startsAt: null, endsAt: null, city: null, state: null });
  });

  it("accepts explicit nulls and turns a blank place into null", () => {
    const parsed = createCuencadaInputSchema.parse({ ...announced, startsAt: null, endsAt: null, city: "  ", state: "" });
    expect(parsed).toMatchObject({ startsAt: null, endsAt: null, city: null, state: null });
  });

  it("rejects one date without the other", () => {
    const onlyStart = createCuencadaInputSchema.safeParse({ ...announced, startsAt: "2027-09-13T00:00:00-06:00" });
    expect(onlyStart.success).toBe(false);
    expect(onlyStart.error?.issues[0]).toMatchObject({ path: ["endsAt"], message: CUENCADA_DATES_TOGETHER_MESSAGE });
    expect(createCuencadaInputSchema.safeParse({ ...announced, endsAt: "2027-09-18T00:00:00-06:00" }).success).toBe(false);
    expect(
      createCuencadaInputSchema.safeParse({ ...announced, startsAt: "2027-09-13T00:00:00-06:00", endsAt: null }).success
    ).toBe(false);
  });
});

describe("updateCuencadaInputSchema dates", () => {
  it("accepts clearing both dates, or setting both", () => {
    expect(updateCuencadaInputSchema.safeParse({ startsAt: null, endsAt: null }).success).toBe(true);
    expect(
      updateCuencadaInputSchema.safeParse({ startsAt: "2027-09-13T00:00:00-06:00", endsAt: "2027-09-18T00:00:00-06:00" })
        .success
    ).toBe(true);
  });

  it("accepts moving one end alone (the server checks the merged row)", () => {
    expect(updateCuencadaInputSchema.safeParse({ endsAt: "2027-09-19T00:00:00-06:00" }).success).toBe(true);
  });

  it("rejects clearing one date alone or mixing null and a date", () => {
    expect(updateCuencadaInputSchema.safeParse({ startsAt: null }).success).toBe(false);
    expect(updateCuencadaInputSchema.safeParse({ endsAt: null }).success).toBe(false);
    expect(updateCuencadaInputSchema.safeParse({ startsAt: null, endsAt: "2027-09-18T00:00:00-06:00" }).success).toBe(false);
  });

  it("accepts clearing the place", () => {
    expect(updateCuencadaInputSchema.parse({ city: null, state: "" })).toEqual({ city: null, state: null });
  });
});

describe("hasDates", () => {
  it("narrows only when both dates are set", () => {
    expect(hasDates({ startsAt: "2027-09-13T00:00:00Z", endsAt: "2027-09-18T00:00:00Z" })).toBe(true);
    expect(hasDates({ startsAt: null, endsAt: null })).toBe(false);
    expect(hasDates({ startsAt: "2027-09-13T00:00:00Z", endsAt: null })).toBe(false);
  });
});

describe("cuencadaSummarySchema", () => {
  it("accepts an announced edition with null dates and place", () => {
    const summary = {
      id: "6f1b2a3c-4d5e-4f60-8a7b-9c0d1e2f3a4b",
      year: 2027,
      slug: "2027",
      title: "Cuencada 2027",
      status: CuencadaStatus.Announced,
      startsAt: null,
      endsAt: null,
      timezone: "America/Merida",
      city: null,
      state: null,
      heroImageUrl: null,
      themeColor: "#0b5e55",
      hasMedia: false
    };
    expect(cuencadaSummarySchema.parse(summary)).toEqual(summary);
  });
});

describe("updateCuencadaInputSchema", () => {
  it("does not inject defaults into a partial update", () => {
    expect(updateCuencadaInputSchema.parse({ isPublished: true })).toEqual({ isPublished: true });
  });

  it("rejects an empty patch", () => {
    expect(updateCuencadaInputSchema.safeParse({}).success).toBe(false);
  });
});

describe("createItineraryItemInputSchema", () => {
  it("rejects an end time before the start time", () => {
    const result = createItineraryItemInputSchema.safeParse({ date: "2028-07-01", title: "Cena", startTime: "20:00", endTime: "19:00" });
    expect(result.success).toBe(false);
  });

  it("rejects 12h time strings", () => {
    expect(createItineraryItemInputSchema.safeParse({ date: "2028-07-01", title: "Cena", startTime: "7:30 PM" }).success).toBe(false);
  });

  it("defaults tags to an empty list when omitted", () => {
    expect(createItineraryItemInputSchema.parse({ date: "2028-07-01", title: "Cena" }).tags).toEqual([]);
  });

  it("trims tags and accepts up to 6 tags of up to 24 chars", () => {
    const tags = ["  Incluye comida ", "x".repeat(24), "c", "d", "e", "f"];
    expect(createItineraryItemInputSchema.parse({ date: "2028-07-01", title: "Cena", tags }).tags).toEqual([
      "Incluye comida",
      "x".repeat(24),
      "c",
      "d",
      "e",
      "f"
    ]);
  });

  it("rejects a 7th tag, a 25-char tag and a blank tag", () => {
    const base = { date: "2028-07-01", title: "Cena" };
    expect(createItineraryItemInputSchema.safeParse({ ...base, tags: ["a", "b", "c", "d", "e", "f", "g"] }).success).toBe(false);
    expect(createItineraryItemInputSchema.safeParse({ ...base, tags: ["x".repeat(25)] }).success).toBe(false);
    expect(createItineraryItemInputSchema.safeParse({ ...base, tags: ["   "] }).success).toBe(false);
  });
});

describe("updateItineraryItemInputSchema", () => {
  // A leading/trailing BOM is whitespace for String#trim and is simply removed; inside a tag it is rejected.
  it("rejects bidi controls and invisible characters in tags", () => {
    const base = { date: "2028-07-01", title: "Cena" };
    for (const tag of ["\u202Eatnec", "Co\u200Bmida", "Fami\uFEFFlia", "a\u2066b"]) {
      expect(createItineraryItemInputSchema.safeParse({ ...base, tags: [tag] }).success, JSON.stringify(tag)).toBe(false);
    }
    expect(updateItineraryItemInputSchema.safeParse({ tags: ["\u202Ex"] }).success).toBe(false);
  });

  it("de-duplicates tags case-insensitively after trimming and NFC, keeping the first spelling", () => {
    const base = { date: "2028-07-01", title: "Cena" };
    const decomposed = "Cafe\u0301";
    const parsed = createItineraryItemInputSchema.parse({
      ...base,
      tags: ["Comida", " comida ", "COMIDA", "Café", decomposed, "Playa"]
    });
    expect(parsed.tags).toEqual(["Comida", "Café", "Playa"]);
    // Duplicates do not count toward the limit of 6.
    const many = ["a", "A", "b", "B", "c", "C", "d", "e", "f"];
    expect(createItineraryItemInputSchema.parse({ ...base, tags: many }).tags).toEqual(["a", "b", "c", "d", "e", "f"]);
  });

  it("accepts a tags-only patch and leaves tags absent when not sent", () => {
    expect(updateItineraryItemInputSchema.parse({ tags: ["Familia"] })).toEqual({ tags: ["Familia"] });
    expect(updateItineraryItemInputSchema.parse({ title: "Cena" })).not.toHaveProperty("tags");
  });
});

describe("parseDailyMessagesText error cap", () => {
  it("never returns more than API_ERROR_DETAILS_MAX details and ends with a summary", () => {
    const text = Array.from({ length: 150 }, (_, index) => `basura ${index}`).join("\n");
    const result = parseDailyMessagesText(text);
    expect(result.errorCount).toBe(150);
    expect(result.errors).toHaveLength(API_ERROR_DETAILS_MAX);
    expect(result.errors[98]?.path).toBe("lines.99");
    expect(result.errors[99]).toEqual({ path: "lines", message: expect.stringContaining("51 más") });
    expect(apiErrorSchema.safeParse({ error: { code: "VALIDATION", message: "x", details: result.errors } }).success).toBe(true);
  });

  it("does not add a summary at exactly 100 errors", () => {
    const text = Array.from({ length: 100 }, (_, index) => `basura ${index}`).join("\n");
    const result = parseDailyMessagesText(text);
    expect(result.errors).toHaveLength(100);
    expect(result.errors[99]?.path).toBe("lines.100");
  });
});

describe("location coordinates", () => {
  it("rejects a patch that sets or clears only one coordinate", () => {
    expect(updateLocationInputSchema.safeParse({ lat: null }).success).toBe(false);
    expect(updateLocationInputSchema.safeParse({ lng: -89.6 }).success).toBe(false);
    expect(updateLocationInputSchema.safeParse({ lat: 20.97, lng: null }).success).toBe(false);
  });

  it("accepts setting or clearing both together", () => {
    expect(updateLocationInputSchema.safeParse({ lat: 20.97, lng: -89.62 }).success).toBe(true);
    expect(updateLocationInputSchema.safeParse({ lat: null, lng: null }).success).toBe(true);
    expect(createLocationInputSchema.safeParse({ name: "Izamal", lat: 20.93 }).success).toBe(false);
  });
});

describe("createCuencadaInputSchema timezone and links", () => {
  const base = {
    year: 2028,
    title: "Cuencada 2028",
    startsAt: "2028-07-01T00:00:00-06:00",
    endsAt: "2028-07-05T23:59:59-06:00",
    city: "Oaxaca",
    state: "Oaxaca",
    description: "Próxima reunión."
  };

  it("rejects an unknown timezone", () => {
    expect(createCuencadaInputSchema.safeParse({ ...base, timezone: "Foo/Bar" }).success).toBe(false);
  });

  it("stores the canonical link", () => {
    expect(createCuencadaInputSchema.parse({ ...base, whatsappUrl: "https://Chat.WhatsApp.com/x" }).whatsappUrl).toBe("https://chat.whatsapp.com/x");
  });
});

describe("reorderInputSchema", () => {
  it("rejects duplicate ids", () => {
    const id = "6f1b2a3c-4d5e-4f60-8a7b-9c0d1e2f3a4b";
    expect(reorderInputSchema.safeParse({ ids: [id, id] }).success).toBe(false);
  });
});

describe("T2-BE amendments", () => {
  const id = "6f1b2a3c-4d5e-4f60-8a7b-9c0d1e2f3a4b";

  it("accepts an import with text, entries or both, but not neither", () => {
    expect(dailyMessagesImportInputSchema.safeParse({ text: "2026-09-13|Hola" }).success).toBe(true);
    expect(dailyMessagesImportInputSchema.safeParse({ entries: [{ date: "2026-09-13", message: "Hola" }] }).success).toBe(true);
    expect(dailyMessagesImportInputSchema.safeParse({}).success).toBe(false);
    expect(dailyMessagesImportInputSchema.safeParse({ entries: [] }).success).toBe(false);
  });

  it("defaults the announcement window and checks it on update", () => {
    const created = createAnnouncementInputSchema.parse({ cuencadaId: null, title: "Aviso", body: "Texto" });
    expect(created.expiresAt).toBeNull();
    expect(created).not.toHaveProperty("publishedAt");
    expect(
      updateAnnouncementInputSchema.safeParse({ publishedAt: "2026-09-10T00:00:00Z", expiresAt: "2026-09-09T00:00:00Z" }).success
    ).toBe(false);
    expect(updateAnnouncementInputSchema.safeParse({ expiresAt: null }).success).toBe(true);
  });

  it("filters admin announcements by scope and rejects a portal scope with a cuencadaId", () => {
    expect(adminAnnouncementQuerySchema.parse({ scope: "portal" })).toEqual({ scope: "portal" });
    expect(adminAnnouncementQuerySchema.safeParse({ scope: "cuencada", cuencadaId: id }).success).toBe(true);
    expect(adminAnnouncementQuerySchema.safeParse({ scope: "portal", cuencadaId: id }).success).toBe(false);
    expect(adminAnnouncementQuerySchema.safeParse({ scope: "otra" }).success).toBe(false);
  });
});
