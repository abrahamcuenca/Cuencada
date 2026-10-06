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
    listedInDirectory: null,
    ...overrides
  };
}

const P1 = "11111111-1111-4111-8111-111111111111";
const P2 = "33333333-3333-4333-8333-333333333333";
const U1 = "22222222-2222-4222-8222-222222222222";
const U2 = "44444444-4444-4444-8444-444444444444";
const VIEWER = "55555555-5555-4555-8555-555555555555";

describe("mergeAttendees", () => {
  it("keeps one row per person, preferring the RSVP, and sorts accent-insensitively", () => {
    const merged = mergeAttendees(
      [candidate({ personId: P1, userId: U1, accountName: "Ángel", fullName: "Ángel Cuenca" })],
      [
        candidate({ personId: P1, userId: U1, accountName: "Ángel" }),
        candidate({ personId: "p2", fullName: "Beatriz" })
      ],
      VIEWER
    );
    expect(merged.map((row) => [row.displayName, row.source])).toEqual([
      ["Ángel", "rsvp"],
      ["Beatriz", "attendance"]
    ]);
  });

  it("uses the nickname for people without an account", () => {
    const [row] = mergeAttendees([], [candidate({ personId: P1, nickname: "Tita", fullName: "Rosa María" })], VIEWER);
    expect(row?.displayName).toBe("Tita");
  });

  it("anonymizes unlisted accounts for others, after dedupe and before sorting", () => {
    const merged = mergeAttendees(
      [candidate({ personId: P1, userId: U1, accountName: "Abel", avatarKey: "a.webp", listedInDirectory: false })],
      [
        candidate({ personId: P1, userId: U1, accountName: "Abel", avatarKey: "a.webp", listedInDirectory: false }),
        candidate({ personId: P2, userId: U2, accountName: "Zacarías", listedInDirectory: true })
      ],
      VIEWER
    );
    expect(merged).toEqual([
      { personId: null, userId: null, displayName: "Familiar", avatarKey: null, source: "rsvp", isMe: false },
      { personId: P2, userId: U2, displayName: "Zacarías", avatarKey: null, source: "attendance", isMe: false }
    ]);
  });

  it("keeps the viewer's own row complete even when unlisted", () => {
    const [row] = mergeAttendees(
      [candidate({ personId: P1, userId: U1, accountName: "Abel", avatarKey: "a.webp", listedInDirectory: false })],
      [],
      U1
    );
    expect(row).toEqual({
      personId: P1,
      userId: U1,
      displayName: "Abel",
      avatarKey: "a.webp",
      source: "rsvp",
      isMe: true
    });
  });
});

describe("toAttendees", () => {
  it("returns null avatars and warns once when object storage is unavailable", async () => {
    const storage = new FakeStorage();
    vi.spyOn(storage, "presignGet").mockRejectedValue(new AppError("SERVICE_UNAVAILABLE"));
    const warn = vi.fn();
    const log = { warn } as unknown as FastifyBaseLogger; // test-only: only `warn` is called
    const merged = mergeAttendees(
      [candidate({ personId: P1, userId: U1, accountName: "A", avatarKey: "a.webp" })],
      [candidate({ personId: "p2", fullName: "B", avatarKey: "b.webp" })],
      U1
    );
    const rows = await toAttendees(merged, storage, log);
    expect(rows.map((row) => [row.avatarUrl, row.isMe])).toEqual([
      [null, true],
      [null, false]
    ]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("never signs an avatar for an anonymized row", async () => {
    const storage = new FakeStorage();
    const presign = vi.spyOn(storage, "presignGet");
    const log = { warn: vi.fn() } as unknown as FastifyBaseLogger; // test-only: only `warn` is called
    const merged = mergeAttendees(
      [candidate({ personId: P1, userId: U1, accountName: "A", avatarKey: "a.webp", listedInDirectory: false })],
      [],
      VIEWER
    );
    const [row] = await toAttendees(merged, storage, log);
    expect(row).toMatchObject({ personId: null, userId: null, displayName: "Familiar", avatarUrl: null });
    expect(presign).not.toHaveBeenCalled();
  });

  it("rethrows unexpected storage errors", async () => {
    const storage = new FakeStorage();
    vi.spyOn(storage, "presignGet").mockRejectedValue(new Error("boom"));
    const log = { warn: vi.fn() } as unknown as FastifyBaseLogger; // test-only: only `warn` is called
    const merged = mergeAttendees([candidate({ userId: U1, accountName: "A", avatarKey: "a.webp" })], [], U1);
    await expect(toAttendees(merged, storage, log)).rejects.toThrow("boom");
  });
});
