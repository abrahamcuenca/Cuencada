import { describe, expect, it } from "vitest";
import { decodeDirectoryCursor, encodeDirectoryCursor } from "./cursor.js";
import { escapeLikePattern } from "./repository.js";

const id = "1b2c3d4e-5f60-4b7c-9d8e-0f1a2b3c4d5e";

describe("encodeDirectoryCursor", () => {
  it("encodes only the user id and round-trips it", () => {
    const cursor = encodeDirectoryCursor(id);
    expect(Buffer.from(cursor, "base64url").toString("utf8")).toBe(id);
    expect(decodeDirectoryCursor(cursor)).toEqual({ id });
  });
});

describe("decodeDirectoryCursor", () => {
  it.each([
    "",
    "abc",
    Buffer.from("not-a-uuid").toString("base64url"),
    `n.${Buffer.from(`${id}:ana`).toString("base64url")}`,
    `i.${Buffer.from(id).toString("base64url")}`
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
