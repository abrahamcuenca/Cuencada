import { describe, expect, it } from "vitest";
import { API_ERROR_DETAILS_MAX, apiErrorSchema } from "./common.js";
import {
  adminAnnouncementQuerySchema,
  createAnnouncementInputSchema,
  createCuencadaInputSchema,
  createItineraryItemInputSchema,
  createLocationInputSchema,
  dailyMessageLineSchema,
  dailyMessagesImportInputSchema,
  parseDailyMessagesText,
  reorderInputSchema,
  updateAnnouncementInputSchema,
  updateCuencadaInputSchema,
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
