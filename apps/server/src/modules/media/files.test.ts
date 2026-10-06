import { describe, expect, it } from "vitest";
import { FakeStorage } from "../../../test/helpers/fakes.js";
import {
  createCuencada,
  insertMedia,
  makeDecompressionBombPng,
  makeJpegWithGps,
  makeMp4,
  makeMp4WithLocation,
  makePng,
  makeWebp,
  PLANTED_LOCATION
} from "../../../test/helpers/media.js";
import { READ_CHUNK_BYTES } from "./constants.js";
import { decodeCursor, encodeCursor } from "./cursor.js";
import { readObjectInChunks } from "./jobs/mediaProcess.js";
import { allObjectKeys } from "./service.js";
import {
  extensionForMime,
  FILE_NAME_MAX_LENGTH,
  mediaKeys,
  neutralizeVideoMetadata,
  normalizeContentType,
  readMp4DurationSeconds,
  sanitizeFileName,
  signatureMatches,
  sniffMediaType,
  VideoStructureError
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

  it("gives videos a display copy in their own container", () => {
    expect(mediaKeys(2026, ID, "video/quicktime").display).toBe(`cuencadas/2026/display/${ID}.mov`);
    expect(mediaKeys(2026, ID, "video/mp4").display).toBe(`cuencadas/2026/display/${ID}.mp4`);
  });
});

describe("neutralizeVideoMetadata", () => {
  it("turns udta/meta/uuid into same-size zeroed free boxes and keeps sizes and chunk offsets", () => {
    const fixture = makeMp4WithLocation();
    const original = Buffer.from(fixture.bytes);
    const output = Buffer.from(fixture.bytes);

    const neutralized = neutralizeVideoMetadata(output);

    // moov/udta, moov/meta, moov/trak/udta and the top-level XMP uuid.
    expect(neutralized).toBe(4);
    expect(output.length).toBe(original.length);
    for (const secret of [PLANTED_LOCATION, "+20.9674", "\xa9xyz", "\xa9mak", "\xa9mod", "\xa9swr", "\xa9day", "ISO6709", "xmpmeta", "GPSLatitude", "iPhone 15 Pro", "Apple"]) {
      expect(output.includes(Buffer.from(secret, "latin1"))).toBe(false);
    }
    expect(original.includes(Buffer.from(PLANTED_LOCATION, "latin1"))).toBe(true);
    // The chunk offset is untouched and still points at the same media bytes.
    expect(output.readUInt32BE(fixture.stcoEntryOffset)).toBe(fixture.mdatPayloadOffset);
    expect(output.subarray(fixture.mdatPayloadOffset, fixture.mdatPayloadOffset + fixture.payload.length)).toEqual(fixture.payload);
    // Container structure and the playable header are intact.
    expect(sniffMediaType(output)).toBe("video/quicktime");
    expect(readMp4DurationSeconds(output)).toBe(9);
    expect(output.includes(Buffer.from("free", "latin1"))).toBe(true);
    expect(neutralizeVideoMetadata(Buffer.from(output))).toBe(0);
  });

  it("leaves a file without metadata byte-identical", () => {
    const plain = makeMp4("isom", 5);
    const copy = Buffer.from(plain);

    expect(neutralizeVideoMetadata(copy)).toBe(0);
    expect(copy.equals(plain)).toBe(true);
  });

  it("tolerates and keeps 1–7 stray bytes after the last top-level box", () => {
    const fixture = makeMp4WithLocation("isom");
    for (const trailing of [1, 7]) {
      const tail = Buffer.alloc(trailing, 0xab);
      const output = Buffer.concat([fixture.bytes, tail]);

      expect(neutralizeVideoMetadata(output)).toBe(4);
      expect(output.length).toBe(fixture.bytes.length + trailing);
      expect(output.subarray(-trailing)).toEqual(tail);
      expect(output.includes(Buffer.from(PLANTED_LOCATION, "latin1"))).toBe(false);
    }
  });

  it("stays fail-closed for 8+ stray bytes at the top level and any stray bytes inside a container", () => {
    const plain = makeMp4("isom");
    expect(() => neutralizeVideoMetadata(Buffer.concat([plain, Buffer.from([0, 0, 0, 99, 1, 2, 3, 4])]))).toThrow(VideoStructureError);
    // A moov whose declared size leaves 3 bytes after its last child.
    const child = Buffer.concat([Buffer.from([0, 0, 0, 8]), Buffer.from("free", "latin1")]);
    const moov = Buffer.concat([Buffer.from([0, 0, 0, 8 + child.length + 3]), Buffer.from("moov", "latin1"), child, Buffer.alloc(3)]);
    expect(() => neutralizeVideoMetadata(Buffer.from(moov))).toThrow(VideoStructureError);
  });

  it("throws on inconsistent box sizes", () => {
    const broken = Buffer.from(makeMp4("isom"));
    broken.writeUInt32BE(0xffff, broken.indexOf(Buffer.from("moov")) - 4);
    expect(() => neutralizeVideoMetadata(broken)).toThrow(VideoStructureError);
    expect(() => neutralizeVideoMetadata(Buffer.from([0, 0, 0, 4, 0x66, 0x72, 0x65, 0x65]))).toThrow(VideoStructureError);
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

  it.each([
    ["19 digits (bigint max)", "9223372036854775807"],
    ["20 digits", "99999999999999999999"],
    ["18 digits past year 9999", "253402300800000000"]
  ])("rejects an out-of-range timestamp: %s", (_label, micros) => {
    expect(() => decodeCursor(encodeCursor({ micros, id: ID }))).toThrow(expect.objectContaining({ code: "VALIDATION" }));
  });

  it("accepts the largest allowed timestamp", () => {
    expect(decodeCursor(encodeCursor({ micros: "253402300799999999", id: ID })).micros).toBe("253402300799999999");
  });
});

describe("readObjectInChunks", () => {
  it("reassembles an object exactly from sequential ranged reads into one buffer", async () => {
    const storage = new FakeStorage();
    const body = Buffer.from(Array.from({ length: 100 }, (_, index) => (index * 37) % 256));
    await storage.put({ key: "k", body, contentType: "video/mp4" });
    const ranges: Array<[number, number]> = [];
    const realGetRange = storage.getRange.bind(storage);
    storage.getRange = async (key, start, end) => {
      ranges.push([start, end]);
      return realGetRange(key, start, end);
    };

    const output = await readObjectInChunks(storage, "k", body.length, 16);

    expect(output.equals(body)).toBe(true);
    expect(ranges).toEqual([
      [0, 15],
      [16, 31],
      [32, 47],
      [48, 63],
      [64, 79],
      [80, 95],
      [96, 99]
    ]);
    expect(READ_CHUNK_BYTES).toBe(8 * 1024 * 1024);
  });

  it("fails with size_mismatch when the object is shorter than declared", async () => {
    const storage = new FakeStorage();
    await storage.put({ key: "k", body: new Uint8Array(20), contentType: "video/mp4" });

    await expect(readObjectInChunks(storage, "k", 40, 16)).rejects.toMatchObject({ code: "size_mismatch" });
  });
});

describe("allObjectKeys", () => {
  it("includes the scrubbed video display key and both image derivatives", async () => {
    const { id: cuencadaId } = await createCuencada();
    const video = await insertMedia({
      id: ID,
      cuencadaId,
      kind: "video",
      mimeType: "video/quicktime",
      objectKey: `cuencadas/2026/originals/${ID}.mov`,
      thumbKey: null,
      displayKey: null
    });
    const image = await insertMedia({ cuencadaId, thumbKey: null, displayKey: null, mimeType: "image/png" });

    expect(allObjectKeys(video, 2026)).toEqual([`cuencadas/2026/originals/${ID}.mov`, `cuencadas/2026/display/${ID}.mov`]);
    expect(allObjectKeys(image, 2026)).toEqual([
      image.objectKey,
      `cuencadas/2026/display/${image.id}.webp`,
      `cuencadas/2026/thumbs/${image.id}.webp`
    ]);
  });
});
