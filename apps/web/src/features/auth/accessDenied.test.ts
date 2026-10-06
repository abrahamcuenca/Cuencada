import { describe, expect, it } from "vitest";
import { classifyAccessDenial, EMAIL_UNVERIFIED_CODE } from "./accessDenied";

function httpError(status: number, code: string | null): unknown {
  return { status, data: code === null ? "<html>proxy</html>" : { error: { code, message: "x" } } };
}

const verified = { emailVerified: true };
const unverified = { emailVerified: false };

describe("classifyAccessDenial", () => {
  it("returns unverified for EMAIL_UNVERIFIED even when the cached user looks verified", () => {
    expect(classifyAccessDenial(httpError(403, EMAIL_UNVERIFIED_CODE), verified)).toBe("unverified");
    expect(classifyAccessDenial(httpError(403, EMAIL_UNVERIFIED_CODE), null)).toBe("unverified");
  });

  it("returns unverified for FORBIDDEN when the user's email is not verified", () => {
    expect(classifyAccessDenial(httpError(403, "FORBIDDEN"), unverified)).toBe("unverified");
  });

  it("returns forbidden for FORBIDDEN when the user is verified or unknown", () => {
    expect(classifyAccessDenial(httpError(403, "FORBIDDEN"), verified)).toBe("forbidden");
    expect(classifyAccessDenial(httpError(403, "FORBIDDEN"), null)).toBe("forbidden");
  });

  it("returns forbidden for any other 403 (other codes or a non-envelope body)", () => {
    expect(classifyAccessDenial(httpError(403, "CSRF_FAILED"), unverified)).toBe("forbidden");
    expect(classifyAccessDenial(httpError(403, null), unverified)).toBe("forbidden");
    expect(classifyAccessDenial({ status: "PARSING_ERROR", originalStatus: 403, data: "x", error: "x" }, unverified)).toBe("forbidden");
  });

  it("returns null for anything that is not a 403", () => {
    expect(classifyAccessDenial(httpError(401, EMAIL_UNVERIFIED_CODE), unverified)).toBeNull();
    expect(classifyAccessDenial(httpError(500, "INTERNAL"), unverified)).toBeNull();
    expect(classifyAccessDenial({ status: "FETCH_ERROR", error: "offline" }, unverified)).toBeNull();
    expect(classifyAccessDenial(undefined, unverified)).toBeNull();
    expect(classifyAccessDenial(new Error("boom"), unverified)).toBeNull();
  });
});
