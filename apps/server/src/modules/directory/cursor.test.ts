import { cursorSchema } from "@cuencada/types";
import { describe, expect, it } from "vitest";
import { decodeDirectoryCursor, encodeDirectoryCursor } from "./cursor.js";
import { escapeLikePattern } from "./repository.js";

const id = "1b2c3d4e-5f60-4b7c-9d8e-0f1a2b3c4d5e";

describe("encodeDirectoryCursor", () => {
  it("round-trips the sort name and id, including colons and accents", () => {
    const cursor = encodeDirectoryCursor(id, "pérez: la güera");
    expect(cursorSchema.safeParse(cursor).success).toBe(true);
    expect(decodeDirectoryCursor(cursor)).toEqual({
      kind: "name",
      id,
      sortName: "pérez: la güera"
    });
  });

  it("falls back to an id-only cursor when the name would exceed 512 characters", () => {
    const cursor = encodeDirectoryCursor(id, "ñ".repeat(200));
    expect(cursor.length).toBeLessThanOrEqual(512);
    expect(cursorSchema.safeParse(cursor).success).toBe(true);
    expect(decodeDirectoryCursor(cursor)).toEqual({ kind: "id", id });
  });
});

describe("decodeDirectoryCursor", () => {
  it.each([
    "",
    "x.abc",
    "n.",
    `n.${Buffer.from("not-a-uuid:name").toString("base64url")}`,
    `i.${Buffer.from("123").toString("base64url")}`
  ])("throws VALIDATION for %j", (raw) => {
    expect(() => decodeDirectoryCursor(raw)).toThrow(expect.objectContaining({ code: "VALIDATION" }));
  });
});

describe("escapeLikePattern", () => {
  it("escapes %, _ and backslash and leaves other text alone", () => {
    expect(escapeLikePattern("100%_a\\b")).toBe("100\\%\\_a\\\\b");
    expect(escapeLikePattern("Pérez")).toBe("Pérez");
  });
});
