import { describe, expect, it } from "vitest";
import { formatRelativeTime, summarizeUserAgent } from "./sessionDisplay";

describe("summarizeUserAgent", () => {
  it.each([
    ["Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1", "iPhone · Safari"],
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/129.0 Safari/537.36 Edg/129.0", "Windows · Edge"],
    ["Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 SamsungBrowser/25.0 Chrome/121.0 Mobile Safari/537.36", "Android · Samsung Internet"],
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X 14.5; rv:131.0) Gecko/20100101 Firefox/131.0", "Mac · Firefox"],
    ["Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/129.0 Safari/537.36", "Linux · Chrome"]
  ])("summarizes %s", (ua, label) => {
    expect(summarizeUserAgent(ua).label).toBe(label);
  });

  it("handles a missing or unknown User-Agent", () => {
    expect(summarizeUserAgent(null).label).toBe("Dispositivo desconocido");
    expect(summarizeUserAgent("curl/8.0").label).toBe("Navegador desconocido");
  });
});

describe("formatRelativeTime", () => {
  const now = new Date("2026-10-06T12:00:00Z");

  it("says ahora under a minute", () => {
    expect(formatRelativeTime("2026-10-06T11:59:30Z", now)).toBe("ahora");
  });

  it("uses the largest whole unit", () => {
    expect(formatRelativeTime("2026-10-06T11:58:00Z", now)).toBe("hace 2 minutos");
    expect(formatRelativeTime("2026-10-03T12:00:00Z", now)).toBe("hace 3 días");
  });

  it("returns an empty string for an invalid date", () => {
    expect(formatRelativeTime("no-es-fecha", now)).toBe("");
  });
});
