import { describe, expect, it } from "vitest";
import { makeDecompressionBombPng, makeJpegWithGps, makeMp4, makePng, makeWebp } from "../../../test/helpers/media.js";
import { decodeCursor, encodeCursor } from "./cursor.js";
import {
  extensionForMime,
  FILE_NAME_MAX_LENGTH,
  mediaKeys,
  normalizeContentType,
  readMp4DurationSeconds,
  sanitizeFileName,
  signatureMatches,
  sniffMediaType
} from "./files.js";

const ID = "6f1d3b0e-2c4a-4b8e-9f00-1234567890ab";

describe("sanitizeFileName", () => {
  it("keeps an ordinary name unchanged", () => {
    expect(sanitizeFileName("IMG_0001.JPG")).toBe("IMG_0001.JPG");
  });

  it("strips directory components with either separator", () => {
    expect(sanitizeFileName("../../etc/passwd")).toBe("passwd");
    expect(sanitizeFileName("C:\\Users\\abe\\foto.jpg")).toBe("foto.jpg");
  });

  it("strips control, bidi and zero-width characters", () => {
    const rlo = String.fromCodePoint(0x202e);
    const zwsp = String.fromCodePoint(0x200b);
    const bom = String.fromCodePoint(0xfeff);
    expect(sanitizeFileName(`foto${rlo}gpj.exe`)).toBe("fotogpj.exe");
    expect(sanitizeFileName(`a${zwsp}b${bom}\u0007c\n.jpg`)).toBe("abc.jpg");
  });

  it("caps the length in code points", () => {
    const result = sanitizeFileName(`${"é".repeat(400)}.jpg`);
    expect(Array.from(result)).toHaveLength(FILE_NAME_MAX_LENGTH);
  });

  it("falls back to a placeholder when nothing visible remains", () => {
    expect(sanitizeFileName("..")).toBe("archivo");
    expect(sanitizeFileName("dir/")).toBe("archivo");
    expect(sanitizeFileName(String.fromCodePoint(0x202e))).toBe("archivo");
  });
});

describe("mediaKeys", () => {
  it("builds server-side keys from the year, id and MIME type only", () => {
    expect(mediaKeys(2026, ID, "image/jpeg")).toEqual({
      original: `cuencadas/2026/originals/${ID}.jpg`,
      thumb: `cuencadas/2026/thumbs/${ID}.webp`,
      display: `cuencadas/2026/display/${ID}.webp`
    });
    expect(extensionForMime("video/quicktime")).toBe("mov");
  });
});

describe("normalizeContentType", () => {
  it("lowercases and drops parameters", () => {
    expect(normalizeContentType("Image/JPEG; charset=binary")).toBe("image/jpeg");
    expect(normalizeContentType(null)).toBeNull();
    expect(normalizeContentType(" ")).toBeNull();
  });
});

describe("sniffMediaType", () => {
  it("recognizes real JPEG, PNG and WebP files", async () => {
    expect(sniffMediaType(await makeJpegWithGps())).toBe("image/jpeg");
    expect(sniffMediaType(await makePng())).toBe("image/png");
    expect(sniffMediaType(await makeWebp(20, 10))).toBe("image/webp");
  });

  it("recognizes MP4 and QuickTime brands", () => {
    expect(sniffMediaType(makeMp4("isom"))).toBe("video/mp4");
    expect(sniffMediaType(makeMp4("mp42"))).toBe("video/mp4");
    expect(sniffMediaType(makeMp4("qt  "))).toBe("video/quicktime");
  });

  it("rejects text, unknown brands and truncated input", () => {
    expect(sniffMediaType(Buffer.from("hola, esto no es una foto"))).toBeNull();
    expect(sniffMediaType(makeMp4("heic"))).toBeNull();
    expect(sniffMediaType(new Uint8Array([0xff, 0xd8]))).toBeNull();
    expect(sniffMediaType(new Uint8Array())).toBeNull();
  });
});

describe("signatureMatches", () => {
  it("requires images to match the declared type exactly", async () => {
    const png = await makePng();
    expect(signatureMatches("image/png", png)).toBe(true);
    expect(signatureMatches("image/jpeg", png)).toBe(false);
    expect(signatureMatches("image/jpeg", Buffer.from("not a jpeg"))).toBe(false);
  });

  it("accepts an MP4 brand for a QuickTime upload but not the reverse", () => {
    expect(signatureMatches("video/quicktime", makeMp4("isom"))).toBe(true);
    expect(signatureMatches("video/quicktime", makeMp4("qt  "))).toBe(true);
    expect(signatureMatches("video/mp4", makeMp4("qt  "))).toBe(false);
  });

  it("rejects a decompression bomb declared as JPEG", () => {
    expect(signatureMatches("image/jpeg", makeDecompressionBombPng())).toBe(false);
  });
});

describe("readMp4DurationSeconds", () => {
  it("reads the mvhd duration when moov is at the start", () => {
    expect(readMp4DurationSeconds(makeMp4("isom", 42))).toBe(42);
  });

  it("returns null without a moov box or for garbage", () => {
    expect(readMp4DurationSeconds(makeMp4("isom").subarray(0, 24))).toBeNull();
    expect(readMp4DurationSeconds(Buffer.from("garbage garbage garbage"))).toBeNull();
    expect(readMp4DurationSeconds(new Uint8Array())).toBeNull();
  });
});

describe("cursor", () => {
  it("round-trips microsecond timestamps and ids", () => {
    const encoded = encodeCursor({ micros: "1791264000123456", id: ID });
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCursor(encoded)).toEqual({ micros: "1791264000123456", id: ID });
  });

  it("throws VALIDATION for cursors it did not produce", () => {
    expect(() => decodeCursor("abc")).toThrow(expect.objectContaining({ code: "VALIDATION" }));
    expect(() => decodeCursor(Buffer.from("x:not-a-uuid").toString("base64url"))).toThrow(
      expect.objectContaining({ code: "VALIDATION" })
    );
  });
});
