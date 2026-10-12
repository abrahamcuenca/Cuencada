import { describe, expect, it } from "vitest";
import {
  EVENT_DATES_TBA,
  eventBadges,
  eventErrorMessage,
  eventIssueCode,
  eventPath,
  formatCardDates,
  formatEventDates,
  participantCountLabel,
  SLUG_CODE_NOTE,
  slugPreview
} from "./format";

const merida = "America/Merida";

function issue(status: number, code: string, message = "Mensaje del servidor."): unknown {
  return { status, data: { error: { code: status === 409 ? "CONFLICT" : "FORBIDDEN", message, details: [{ path: "event", message, code }] } } };
}

describe("formatEventDates", () => {
  it("says Por anunciar when the event has no dates", () => {
    expect(formatEventDates({ startsAt: null, endsAt: null, timezone: merida })).toBe(EVENT_DATES_TBA);
  });

  it("shows one day with its times in the event's timezone", () => {
    // 14:00–18:00 in Mérida (UTC−6).
    const text = formatEventDates({ startsAt: "2026-11-14T20:00:00.000Z", endsAt: "2026-11-15T00:00:00.000Z", timezone: merida });
    expect(text).toMatch(/^sábado, 14 de noviembre de 2026 · 2:00\sp\.\s?m\. – 6:00\sp\.\s?m\.$/);
  });

  it("shows a range of days, across months when needed", () => {
    expect(formatEventDates({ startsAt: "2026-11-14T15:00:00.000Z", endsAt: "2026-11-16T23:00:00.000Z", timezone: merida })).toBe("14 — 16 de noviembre de 2026");
    expect(formatEventDates({ startsAt: "2026-10-30T15:00:00.000Z", endsAt: "2026-11-02T23:00:00.000Z", timezone: merida })).toBe(
      "30 de octubre — 2 de noviembre de 2026"
    );
  });
});

describe("formatCardDates", () => {
  it("adds the year to Por anunciar", () => {
    expect(formatCardDates({ year: 2027, startsAt: null, endsAt: null, timezone: merida })).toBe("Por anunciar · 2027");
  });
});

describe("participantCountLabel", () => {
  it("handles zero, one and many", () => {
    expect(participantCountLabel(0)).toBe("Nadie se ha apuntado");
    expect(participantCountLabel(1)).toBe("1 participante");
    expect(participantCountLabel(12)).toBe("12 participantes");
  });
});

describe("eventBadges", () => {
  it("labels drafts, hidden, participants-only and the viewer's role", () => {
    expect(eventBadges({ status: "draft", visibility: "participants", viewerRole: "organizer" }).map((b) => b.label)).toEqual([
      "Borrador",
      "Solo participantes",
      "Organizas"
    ]);
    expect(eventBadges({ status: "hidden", visibility: "members", viewerRole: null }).map((b) => b.label)).toEqual(["Oculto"]);
    expect(eventBadges({ status: "published", visibility: "members", viewerRole: "participant" }).map((b) => b.label)).toEqual(["Participas"]);
  });
});

describe("slugPreview", () => {
  it("previews the slug of the title plus a placeholder for the random code", () => {
    expect(slugPreview("Carne asada en Año Nuevo", 2026)).toBe("/eventos/2026/carne-asada-en-ano-nuevo-····");
    expect(SLUG_CODE_NOTE).toBe("la dirección lleva un código corto");
  });
});

describe("eventPath", () => {
  it("builds the event URL", () => {
    expect(eventPath({ year: 2026, slug: "carne-asada-k7q2" })).toBe("/eventos/2026/carne-asada-k7q2");
  });
});

describe("eventErrorMessage", () => {
  it("explains the EVENT_* reasons in Spanish", () => {
    expect(eventIssueCode(issue(409, "EVENT_ALBUM_NOT_EMPTY"))).toBe("EVENT_ALBUM_NOT_EMPTY");
    expect(eventErrorMessage(issue(409, "EVENT_ALBUM_NOT_EMPTY"))).toMatch(/Este álbum tiene fotos/);
    expect(eventErrorMessage(issue(409, "EVENT_LAST_ORGANIZER"))).toMatch(/al menos una persona organizando/);
  });

  it("falls back to the server message, then a generic one", () => {
    expect(eventErrorMessage(issue(403, "SOMETHING_NEW", "Otra cosa."))).toBe("Otra cosa.");
    expect(eventErrorMessage(new Error("x"))).toMatch(/Algo salió mal/);
  });
});
