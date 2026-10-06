import { describe, expect, it } from "vitest";
import { CSV_BOM, csvCell, toCsv } from "./csv.js";

describe("csvCell", () => {
  it("leaves plain values alone and renders null as empty", () => {
    expect(csvCell("Ana López")).toBe("Ana López");
    expect(csvCell(3)).toBe("3");
    expect(csvCell(null)).toBe("");
  });

  it.each([
    ['=HYPERLINK("http://x")', '"\'=HYPERLINK(""http://x"")"'],
    ["+1+1", "'+1+1"],
    ["-2+3", "'-2+3"],
    ["@SUM(A1)", "'@SUM(A1)"],
    ["\t=1", "'\t=1"],
    ["\r=1", '"\'\r=1"']
  ])("neutralizes formula trigger %j", (input, expected) => {
    expect(csvCell(input)).toBe(expected);
  });

  it("quotes commas, quotes and newlines", () => {
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell('di "hola"')).toBe('"di ""hola"""');
    expect(csvCell("línea 1\nlínea 2")).toBe('"línea 1\nlínea 2"');
  });
});

describe("toCsv", () => {
  it("starts with a UTF-8 BOM and uses CRLF line endings", () => {
    const csv = toCsv(["a", "b"], [["ñ", null]]);
    expect(csv.startsWith(CSV_BOM)).toBe(true);
    expect(csv).toBe(`${CSV_BOM}a,b\r\nñ,\r\n`);
  });
});
