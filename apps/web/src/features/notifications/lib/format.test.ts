import { describe, expect, it } from "vitest";
import { makeFeed, notificationId, TARGETS } from "../testing/fixtures";
import { groupNotifications, notificationHint, notificationHref, notificationText } from "./format";

const [tag, commented, liked, added, resolved] = makeFeed();
if (tag === undefined || commented === undefined || liked === undefined || added === undefined || resolved === undefined) throw new Error("fixtures");

describe("notificationText", () => {
  it("words each kind in Spanish, coalesced as «Ana y 2 más»", () => {
    expect(notificationText(tag)).toBe("Ana Morales Vega te etiquetó en una foto");
    expect(notificationText(commented)).toBe("Ana Morales Vega y 2 más comentaron tu foto");
    expect(notificationText({ ...commented, count: 1 })).toBe("Ana Morales Vega comentó tu foto");
    expect(notificationText(liked)).toBe("A Ana Morales Vega y 2 más les gustó tu foto");
    expect(notificationText({ ...liked, count: 1 })).toBe("A Ana Morales Vega le gustó tu foto");
    expect(notificationText(added)).toBe("Rosa Quintero Lara te agregó a «Paseo a la laguna»");
    expect(notificationText({ ...added, actor: null })).toBe("Te agregaron a «Paseo a la laguna»");
    expect(notificationText(resolved)).toBe("Tu propuesta del árbol fue aprobada");
    expect(notificationText({ ...resolved, target: { kind: "proposal", proposalId: TARGETS.proposal, status: "rejected" } })).toBe(
      "Tu propuesta del árbol fue rechazada"
    );
  });

  it("falls back to «Alguien» when the actor's account is gone, and asks to approve a tag", () => {
    expect(notificationText({ ...liked, actor: { name: null, avatarUrl: null } })).toBe("A Alguien y 2 más les gustó tu foto");
    expect(notificationText({ ...tag, actor: null })).toBe("Te etiquetaron en una foto");
    expect(notificationHint(tag)).toMatch(/aprobar o rechazar/);
    expect(notificationHint(liked)).toBeNull();
  });
});

describe("notificationHref", () => {
  it("opens a photo on its own page with ?foto=, the event, or the proposal", () => {
    expect(notificationHref(tag)).toBe(`/galeria/2026?foto=${TARGETS.media}`);
    expect(notificationHref(commented)).toBe(`/eventos/2026/paseo-a-la-laguna-k7q2?vista=fotos&foto=${TARGETS.media}`);
    expect(notificationHref(liked)).toBe(`/recuerdos/${TARGETS.proposal}?foto=${TARGETS.media}`);
    expect(notificationHref(added)).toBe("/eventos/2026/paseo-a-la-laguna-k7q2");
    expect(notificationHref(resolved)).toBe(`/arbol?propuesta=${TARGETS.proposal}`);
  });
});

describe("groupNotifications", () => {
  it("groups newest-first entries into Hoy, Ayer, Esta semana and Anteriores in the reader's timezone", () => {
    const now = new Date("2026-10-11T18:00:00.000Z");
    const at = (iso: string, n: number) => ({ ...tag, id: notificationId(n), createdAt: iso });
    const items = [
      at("2026-10-11T07:00:00.000Z", 1), // 01:00 in Mexico City: today
      at("2026-10-11T05:00:00.000Z", 2), // 23:00 the day before there: yesterday
      at("2026-10-07T12:00:00.000Z", 3),
      at("2026-09-01T12:00:00.000Z", 4)
    ];
    const groups = groupNotifications(items, now, "America/Mexico_City");
    expect(groups.map((group) => [group.label, group.items.map((item) => item.id)])).toEqual([
      ["Hoy", [notificationId(1)]],
      ["Ayer", [notificationId(2)]],
      ["Esta semana", [notificationId(3)]],
      ["Anteriores", [notificationId(4)]]
    ]);
    expect(groupNotifications([], now, "UTC")).toEqual([]);
  });
});
