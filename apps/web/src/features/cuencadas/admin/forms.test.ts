import { describe, expect, it } from "vitest";
import { reorderById } from "./api";
import { moveId } from "./components/common";
import { isoToZonedLocal, issuesToFieldErrors, serverErrorToFieldErrors, toLineErrors, zonedLocalToIso } from "./forms";

describe("zonedLocalToIso", () => {
  it("reads the wall-clock time in the Cuencada's timezone", () => {
    expect(zonedLocalToIso("2026-09-13T00:00", "America/Merida")).toBe("2026-09-13T00:00:00-06:00");
    expect(zonedLocalToIso("2026-09-13T00:00", "UTC")).toBe("2026-09-13T00:00:00+00:00");
  });

  it("handles daylight saving time", () => {
    expect(zonedLocalToIso("2027-07-10T10:00", "America/Chicago")).toBe("2027-07-10T10:00:00-05:00");
    expect(zonedLocalToIso("2027-01-10T10:00", "America/Chicago")).toBe("2027-01-10T10:00:00-06:00");
  });

  it("returns null for values that are not a local date-time", () => {
    expect(zonedLocalToIso("", "America/Merida")).toBeNull();
    expect(zonedLocalToIso("2026-09-13", "America/Merida")).toBeNull();
  });
});

describe("isoToZonedLocal", () => {
  it("shows an instant as wall-clock time in the Cuencada's timezone", () => {
    expect(isoToZonedLocal("2026-09-19T05:59:59Z", "America/Merida")).toBe("2026-09-18T23:59");
  });

  it("round-trips with zonedLocalToIso", () => {
    const iso = zonedLocalToIso("2026-09-14T07:40", "America/Merida");
    expect(iso && isoToZonedLocal(iso, "America/Merida")).toBe("2026-09-14T07:40");
  });
});

describe("issuesToFieldErrors", () => {
  it("keeps the first message per field and sends root issues to _form", () => {
    expect(
      issuesToFieldErrors([
        { path: ["title"], message: "Este campo es obligatorio." },
        { path: ["title"], message: "Otro" },
        { path: [], message: "No hay cambios que guardar." }
      ])
    ).toEqual({ title: "Este campo es obligatorio.", _form: "No hay cambios que guardar." });
  });
});

describe("serverErrorToFieldErrors", () => {
  it("maps VALIDATION details onto fields, dropping a body prefix", () => {
    const error = {
      status: 400,
      data: { error: { code: "VALIDATION", message: "Revisa los campos.", details: [{ path: "body.title", message: "Muy largo." }] } }
    };
    expect(serverErrorToFieldErrors(error, "fallback")).toEqual({ _form: "Revisa los campos.", title: "Muy largo." });
  });

  it("falls back to a generic message for non-contract errors", () => {
    expect(serverErrorToFieldErrors({ status: "FETCH_ERROR", error: "x" }, "Sin conexión.")).toEqual({ _form: "Sin conexión." });
  });
});

describe("toLineErrors", () => {
  it("sorts by line and puts summaries last", () => {
    expect(
      toLineErrors([
        { path: "lines", message: "Demasiados errores" },
        { path: "lines.12", message: "b" },
        { path: "lines.3", message: "a" }
      ])
    ).toEqual([
      { line: 3, message: "a" },
      { line: 12, message: "b" },
      { line: null, message: "Demasiados errores" }
    ]);
  });
});

describe("moveId", () => {
  it("swaps an item with its neighbour", () => {
    expect(moveId(["a", "b", "c"], 1, -1)).toEqual(["b", "a", "c"]);
    expect(moveId(["a", "b", "c"], 1, 1)).toEqual(["a", "c", "b"]);
  });

  it("returns null at the edges", () => {
    expect(moveId(["a", "b"], 0, -1)).toBeNull();
    expect(moveId(["a", "b"], 1, 1)).toBeNull();
    expect(moveId([], 0, 1)).toBeNull();
  });
});

describe("reorderById", () => {
  it("follows the requested order and renumbers sortOrder", () => {
    const items = [
      { id: "a", sortOrder: 0 },
      { id: "b", sortOrder: 1 },
      { id: "c", sortOrder: 2 }
    ];
    expect(reorderById(items, ["c", "a", "b"])).toEqual([
      { id: "c", sortOrder: 0 },
      { id: "a", sortOrder: 1 },
      { id: "b", sortOrder: 2 }
    ]);
  });
});
