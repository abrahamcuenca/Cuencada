import { describe, expect, it } from "vitest";
import { displayHost, HOST_TEXT_MAX, LINK_TEXT_MAX, linkify, safeHref } from "./linkify";

const links = (text: string): string[] => linkify(text).flatMap((segment) => (segment.kind === "link" ? [segment.href] : []));

describe("linkify", () => {
  it("links http and https URLs and keeps the surrounding text", () => {
    const segments = linkify("Fotos: https://example.com/album?id=3 y http://example.org.");
    expect(segments).toEqual([
      { kind: "text", text: "Fotos: " },
      { kind: "link", text: "https://example.com/album?id=3", href: "https://example.com/album?id=3", title: "https://example.com/album?id=3" },
      { kind: "text", text: " y " },
      { kind: "link", text: "http://example.org", href: "http://example.org/", title: "http://example.org/" },
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

  it("shows a lookalike (Cyrillic) host as punycode, in the text, href and title", () => {
    // "аpple.com" with a Cyrillic "а" (U+0430).
    const [link] = linkify("https://\u0430pple.com/login").filter((segment) => segment.kind === "link");
    expect(link).toEqual({
      kind: "link",
      text: "https://xn--pple-43d.com/login",
      href: "https://xn--pple-43d.com/login",
      title: "https://xn--pple-43d.com/login"
    });
  });

  it("never linkifies a URL with bidi controls or invisible characters", () => {
    for (const text of [
      "https://example.com/\u202Egpj.exe",
      "https://exa\u200Bmple.com/",
      "https://example.com/\u2066x\u2069",
      "https://\uFEFFexample.com"
    ]) {
      expect(links(text)).toEqual([]);
    }
  });

  it("normalizes ideographic full stops so the shown host is the real one", () => {
    for (const dot of ["\u3002", "\uFF0E", "\uFF61"]) {
      const [link] = linkify(`https://evil.com${dot}com/x`).filter((segment) => segment.kind === "link");
      expect(link).toMatchObject({ text: "https://evil.com.com/x", href: "https://evil.com.com/x" });
    }
  });

  it("builds the visible text from the parsed URL and truncates long ones", () => {
    const long = `https://example.com/${"a".repeat(100)}`;
    const [link] = linkify(long).filter((segment) => segment.kind === "link");
    expect(link?.text).toHaveLength(LINK_TEXT_MAX);
    expect(link?.text.endsWith("…")).toBe(true);
    expect(link).toMatchObject({ href: long, title: long });
    // Hosts are lower-cased and paths percent-encoded: what you see is where it goes.
    expect(linkify("https://EXAMPLE.com/Mérida")[0]).toMatchObject({ text: "https://example.com/M%C3%A9rida" });
  });

  it("never truncates the host: a long one keeps its registrable end", () => {
    const spoof = "https://accounts.google.com.secure-login-verification-portal-cuencada.evil.example/x";
    const [link] = linkify(spoof).filter((segment) => segment.kind === "link");
    expect(link?.text).toBe("https://…evil.example/x");
    expect(link?.text).toContain("evil.example");
    expect(link).toMatchObject({ href: spoof, title: spoof });
    expect(displayHost(`${"a".repeat(30)}.sub.cuencada.evil.example`)).toBe("…sub.cuencada.evil.example");
    expect(displayHost(`${"b".repeat(50)}.example`)).toBe("…example");
    expect(displayHost(`x.${"c".repeat(60)}`)).toHaveLength(HOST_TEXT_MAX);
  });

  it("with a short host and a long path, truncates only the path", () => {
    const long = `https://example.com/fotos/${"a".repeat(100)}?q=1`;
    const [link] = linkify(long).filter((segment) => segment.kind === "link");
    expect(link?.text.startsWith("https://example.com/fotos/")).toBe(true);
    expect(link?.text).toHaveLength(LINK_TEXT_MAX);
    expect(link?.text.endsWith("…")).toBe(true);
  });
});
