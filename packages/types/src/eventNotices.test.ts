import { describe, expect, it } from "vitest";
import { EVENT_NOTICES_MAX, eventNoticeListSchema, eventNoticeSchema } from "./events.js";
import * as barrel from "./index.js";

const notice = {
  event: { id: "00000000-0000-4000-8000-000000000001", year: 2026, slug: "viaje-cdmx-k7q2", title: "Viaje a CDMX" },
  addedByName: "Ana Morales Vega",
  role: "participant",
  addedAt: "2026-10-11T10:00:00.000Z",
  canLeave: true
};

describe("eventNoticeSchema (WP-5.3 consent notice)", () => {
  it("accepts a notice, a removed adder (null name) and strips unknown keys", () => {
    expect(eventNoticeSchema.parse(notice)).toEqual(notice);
    expect(eventNoticeSchema.parse({ ...notice, addedByName: null }).addedByName).toBeNull();
    expect(eventNoticeSchema.parse({ ...notice, addedByEmail: "ana@example.com" })).not.toHaveProperty("addedByEmail");
  });

  it("rejects a bad role or event ref and caps the list", () => {
    expect(eventNoticeSchema.safeParse({ ...notice, role: "owner" }).success).toBe(false);
    expect(eventNoticeSchema.safeParse({ ...notice, event: { ...notice.event, id: "nope" } }).success).toBe(false);
    const items = Array.from({ length: EVENT_NOTICES_MAX + 1 }, () => notice);
    expect(eventNoticeListSchema.safeParse({ items }).success).toBe(false);
    expect(eventNoticeListSchema.parse({ items: items.slice(1) }).items).toHaveLength(EVENT_NOTICES_MAX);
  });

  it("is exported from the barrel", () => {
    expect(barrel.eventNoticeListSchema).toBe(eventNoticeListSchema);
  });
});
