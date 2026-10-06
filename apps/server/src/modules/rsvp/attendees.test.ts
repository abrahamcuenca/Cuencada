import type { FastifyBaseLogger } from "fastify";
import { describe, expect, it, vi } from "vitest";
import { FakeStorage } from "../../../test/helpers/fakes.js";
import { AppError } from "../../lib/errors.js";
import { mergeAttendees, toAttendees } from "./attendees.js";
import type { AttendeeCandidate } from "./repository.js";

function candidate(overrides: Partial<AttendeeCandidate>): AttendeeCandidate {
  return {
    personId: null,
    userId: null,
    accountName: null,
    nickname: null,
    fullName: null,
    avatarKey: null,
    ...overrides
  };
}

const P1 = "11111111-1111-4111-8111-111111111111";
const U1 = "22222222-2222-4222-8222-222222222222";

describe("mergeAttendees", () => {
  it("keeps one row per person, preferring the RSVP, and sorts accent-insensitively", () => {
    const merged = mergeAttendees(
      [
        candidate({
          personId: P1,
          userId: U1,
          accountName: "Ángel",
          fullName: "Ángel Cuenca"
        })
      ],
      [
        candidate({ personId: P1, userId: U1, accountName: "Ángel" }),
        candidate({ personId: "p2", fullName: "Beatriz" })
      ]
    );
    expect(merged.map((row) => [row.displayName, row.source])).toEqual([
      ["Ángel", "rsvp"],
      ["Beatriz", "attendance"]
    ]);
  });

  it("uses the nickname for people without an account", () => {
    const [row] = mergeAttendees([], [candidate({ personId: P1, nickname: "Tita", fullName: "Rosa María" })]);
    expect(row?.displayName).toBe("Tita");
  });
});

describe("toAttendees", () => {
  it("returns null avatars and warns once when object storage is unavailable", async () => {
    const storage = new FakeStorage();
    vi.spyOn(storage, "presignGet").mockRejectedValue(new AppError("SERVICE_UNAVAILABLE"));
    const warn = vi.fn();
    const log = { warn } as unknown as FastifyBaseLogger; // test-only: only `warn` is called
    const merged = mergeAttendees(
      [
        candidate({
          personId: P1,
          userId: U1,
          accountName: "A",
          avatarKey: "a.webp"
        })
      ],
      [candidate({ personId: "p2", fullName: "B", avatarKey: "b.webp" })]
    );
    const rows = await toAttendees(merged, U1, storage, log);
    expect(rows.map((row) => [row.avatarUrl, row.isMe])).toEqual([
      [null, true],
      [null, false]
    ]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("rethrows unexpected storage errors", async () => {
    const storage = new FakeStorage();
    vi.spyOn(storage, "presignGet").mockRejectedValue(new Error("boom"));
    const log = { warn: vi.fn() } as unknown as FastifyBaseLogger; // test-only: only `warn` is called
    const merged = mergeAttendees([candidate({ userId: U1, accountName: "A", avatarKey: "a.webp" })], []);
    await expect(toAttendees(merged, U1, storage, log)).rejects.toThrow("boom");
  });
});
