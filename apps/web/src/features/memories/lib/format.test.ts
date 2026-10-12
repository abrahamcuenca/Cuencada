import { describe, expect, it } from "vitest";
import { isNotFound, mediaCountLabel, memoryErrorMessage, memoryPath } from "./format";

function apiError(status: number, code: string, detailCode?: string): unknown {
  return {
    status,
    data: { error: { code, message: "Mensaje del servidor.", ...(detailCode === undefined ? {} : { details: [{ path: "memoryAlbum", message: "x", code: detailCode }] }) } }
  };
}

describe("mediaCountLabel", () => {
  it("says no photos yet, one, or many (es-MX grouping)", () => {
    expect(mediaCountLabel(0)).toBe("Aún sin fotos");
    expect(mediaCountLabel(1)).toBe("1 foto o video");
    expect(mediaCountLabel(2)).toBe("2 fotos y videos");
    expect(mediaCountLabel(1200)).toBe("1,200 fotos y videos");
  });
});

describe("memoryPath", () => {
  it("encodes the id", () => {
    expect(memoryPath("a/b")).toBe("/recuerdos/a%2Fb");
  });
});

describe("memoryErrorMessage", () => {
  it("explains known detail codes and falls back to the server's message", () => {
    expect(memoryErrorMessage(apiError(409, "CONFLICT", "MEMORY_ALBUM_NOT_EMPTY"))).toMatch(/todavía tiene fotos o videos/);
    expect(memoryErrorMessage(apiError(400, "VALIDATION"))).toBe("Mensaje del servidor.");
    expect(memoryErrorMessage(new Error("x"))).toMatch(/Algo salió mal/);
  });
});

describe("isNotFound", () => {
  it("is true only for 404 NOT_FOUND bodies", () => {
    expect(isNotFound(apiError(404, "NOT_FOUND", "MEMORY_ALBUM_NOT_FOUND"))).toBe(true);
    expect(isNotFound(apiError(403, "FORBIDDEN"))).toBe(false);
    expect(isNotFound(undefined)).toBe(false);
  });
});
