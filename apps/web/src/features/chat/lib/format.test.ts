import { describe, expect, it } from "vitest";
import { makeMessage, ME, PEOPLE } from "../testing/fixtures";
import { buildConversation, dayLabel, roomTimeLabel } from "./format";
import { threadFromPage } from "./thread";

const TZ = "America/Merida";
const NOW = new Date("2026-09-16T18:00:00.000Z");

describe("dayLabel (es-MX)", () => {
  it("says Hoy, Ayer, or the weekday and date", () => {
    expect(dayLabel("2026-09-16T15:00:00.000Z", NOW, TZ)).toBe("Hoy");
    expect(dayLabel("2026-09-15T15:00:00.000Z", NOW, TZ)).toBe("Ayer");
    expect(dayLabel("2026-09-14T15:00:00.000Z", NOW, TZ)).toBe("Lunes 14 de septiembre");
    expect(dayLabel("2025-09-14T15:00:00.000Z", NOW, TZ)).toBe("Domingo 14 de septiembre de 2025");
  });

  it("uses the reader's timezone for the day boundary", () => {
    // 03:00 UTC on the 16th is still the 15th in Mérida (UTC−6).
    expect(dayLabel("2026-09-16T03:00:00.000Z", NOW, TZ)).toBe("Ayer");
  });
});

describe("roomTimeLabel", () => {
  it("shows the time today, ayer, a weekday this week and a short date before", () => {
    expect(roomTimeLabel("2026-09-16T15:41:00.000Z", NOW, TZ)).toBe("9:41 a.m.");
    expect(roomTimeLabel("2026-09-15T15:00:00.000Z", NOW, TZ)).toBe("ayer");
    expect(roomTimeLabel("2026-09-13T15:00:00.000Z", NOW, TZ)).toBe("dom");
    expect(roomTimeLabel("2026-08-02T15:00:00.000Z", NOW, TZ)).toBe("2 ago");
  });
});

describe("buildConversation", () => {
  it("adds day separators, the unread marker and groups bubbles by sender and time", () => {
    const messages = threadFromPage({
      messages: [
        makeMessage(1, { createdAt: "2026-09-14T15:00:00.000Z" }),
        makeMessage(2, { createdAt: "2026-09-14T15:01:00.000Z" }),
        makeMessage(3, { createdAt: "2026-09-14T15:20:00.000Z" }),
        makeMessage(4, { createdAt: "2026-09-15T15:00:00.000Z", sender: ME }),
        makeMessage(5, { createdAt: "2026-09-15T15:01:00.000Z", sender: PEOPLE.tomas })
      ],
      nextBefore: null
    }).messages;
    const items = buildConversation(messages, { meId: ME.userId, now: NOW, timeZone: TZ, firstUnreadId: makeMessage(5).id });
    expect(items.map((item) => (item.kind === "message" ? `${item.message.body}${item.groupStart ? "^" : ""}${item.groupEnd ? "$" : ""}` : item.kind))).toEqual([
      "day",
      "Mensaje 1^",
      "Mensaje 2$",
      "Mensaje 3^$",
      "day",
      "Mensaje 4^$",
      "unread",
      "Mensaje 5^$"
    ]);
    const mine = items.find((item) => item.kind === "message" && item.message.body === "Mensaje 4");
    expect(mine).toMatchObject({ mine: true });
    expect(items[0]).toMatchObject({ kind: "day", label: "Lunes 14 de septiembre" });
  });
});
