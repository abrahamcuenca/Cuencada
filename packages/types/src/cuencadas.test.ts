import { describe, expect, it } from "vitest";
import {
  createCuencadaInputSchema,
  createItineraryItemInputSchema,
  dailyMessageLineSchema,
  parseDailyMessagesText,
  reorderInputSchema,
  updateCuencadaInputSchema
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
    const text = "﻿# mensajes\r\n2026-09-10|uno\r\n\r\n2026-09-11|dos\n";
    expect(parseDailyMessagesText(text)).toEqual({
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
    expect(parseDailyMessagesText("")).toEqual({ entries: [], errors: [] });
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

describe("reorderInputSchema", () => {
  it("rejects duplicate ids", () => {
    const id = "6f1b2a3c-4d5e-4f60-8a7b-9c0d1e2f3a4b";
    expect(reorderInputSchema.safeParse({ ids: [id, id] }).success).toBe(false);
  });
});
