import { describe, expect, it } from "vitest";
import { linkify, safeHref } from "./linkify";

const links = (text: string): string[] => linkify(text).flatMap((segment) => (segment.kind === "link" ? [segment.href] : []));

describe("linkify", () => {
  it("links http and https URLs and keeps the surrounding text", () => {
    const segments = linkify("Fotos: https://example.com/album?id=3 y http://example.org.");
    expect(segments).toEqual([
      { kind: "text", text: "Fotos: " },
      { kind: "link", text: "https://example.com/album?id=3", href: "https://example.com/album?id=3" },
      { kind: "text", text: " y " },
      { kind: "link", text: "http://example.org", href: "http://example.org/" },
      { kind: "text", text: "." }
    ]);
  });

  it("never links javascript:, data:, vbscript: or scheme-less text", () => {
    for (const text of [
      "javascript:alert(1)",
      "JaVaScRiPt:alert(document.cookie)",
      "data:text/html;base64,PHNjcmlwdD4=",
      "vbscript:msgbox(1)",
      "www.example.com",
      "ftp://example.com/archivo"
    ]) {
      expect(links(text)).toEqual([]);
      expect(linkify(text).map((segment) => segment.text).join("")).toBe(text);
    }
  });

  it("does not let a javascript: URL hide inside an http-looking string", () => {
    expect(links("mira https://javascript:alert(1)")).toEqual([]);
    expect(links("x https://ok.example/#javascript:alert(1)")).toEqual(["https://ok.example/#javascript:alert(1)"]);
  });

  it("rejects URLs with credentials (phishing disguise)", () => {
    expect(safeHref("https://banco.example@evil.example/")).toBeNull();
    expect(links("https://user:pw@example.com/")).toEqual([]);
  });

  it("keeps markup as text: angle brackets end a URL and are never parsed", () => {
    const segments = linkify('<img src=x onerror=alert(1)> https://example.com/"><script>');
    expect(segments.map((segment) => segment.text).join("")).toBe('<img src=x onerror=alert(1)> https://example.com/"><script>');
    expect(links('https://example.com/"><script>')).toEqual(["https://example.com/"]);
  });

  it("keeps a balancing parenthesis and drops sentence punctuation", () => {
    expect(links("(ver https://es.wikipedia.org/wiki/Mérida_(Yucatán))")).toEqual([
      new URL("https://es.wikipedia.org/wiki/Mérida_(Yucatán)").href
    ]);
    expect(links("¿Viste https://example.com/a?")).toEqual(["https://example.com/a"]);
  });
});
