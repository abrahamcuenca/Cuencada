import { afterEach, describe, expect, it, vi } from "vitest";
import { jpegOfSize, pngOfSize, stubImagePipeline } from "../testing/imageFixtures";
import { readImageSize } from "./imageSize";
import { AVATAR_RESIZE, GALLERY_RESIZE, ImageDecodeError, shrinkImageIfNeeded } from "./resizeImage";
import { targetSize } from "./resizeCore";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("readImageSize", () => {
  it("reads PNG, JPEG (past an APP segment) and WebP headers", () => {
    const png = new Uint8Array(33);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
    new DataView(png.buffer).setUint32(16, 8000);
    new DataView(png.buffer).setUint32(20, 6000);
    expect(readImageSize(png)).toEqual({ width: 8000, height: 6000 });
    expect(readImageSize(jpegOfSize(12000, 9000))).toEqual({ width: 12000, height: 9000 });

    const vp8x = new Uint8Array(30);
    vp8x.set(new TextEncoder().encode("RIFF"), 0);
    vp8x.set(new TextEncoder().encode("WEBPVP8X"), 8);
    vp8x.set([0x3f, 0x1f, 0x00], 24); // width - 1 = 7999
    vp8x.set([0x6f, 0x17, 0x00], 27); // height - 1 = 5999
    expect(readImageSize(vp8x)).toEqual({ width: 8000, height: 6000 });
  });

  it("returns null for anything else", () => {
    expect(readImageSize(new Uint8Array([1, 2, 3]))).toBeNull();
    expect(readImageSize(new TextEncoder().encode("<svg></svg>"))).toBeNull();
  });
});

describe("targetSize", () => {
  it("leaves gallery photos up to 40 MP alone and brings bigger ones to about 24 MP", () => {
    expect(targetSize({ width: 7000, height: 5000 }, GALLERY_RESIZE.policy)).toBeNull();
    const shrunk = targetSize({ width: 16320, height: 12240 }, GALLERY_RESIZE.policy);
    expect(shrunk).not.toBeNull();
    if (shrunk === null) return;
    // Under iOS WebKit's 16,777,216 px canvas cap.
    expect(shrunk.width * shrunk.height).toBeLessThanOrEqual(16_000_000);
    expect(shrunk.width * shrunk.height).toBeGreaterThan(15_900_000);
    expect(shrunk.width / shrunk.height).toBeCloseTo(16320 / 12240, 2);
  });

  it("caps the avatar's long edge at 2048 px", () => {
    expect(targetSize({ width: 2048, height: 1000 }, AVATAR_RESIZE.policy)).toBeNull();
    expect(targetSize({ width: 3000, height: 4000 }, AVATAR_RESIZE.policy)).toEqual({ width: 1536, height: 2048 });
  });
});

describe("shrinkImageIfNeeded", () => {
  it("re-encodes a 200 MP photo as a ≤ 16 MP JPEG, decoding straight to the target width", async () => {
    const fake = stubImagePipeline({ width: 16320, height: 12240 }, 4321);
    const resized = await shrinkImageIfNeeded(pngOfSize(16320, 12240, "IMG_0001.png"), GALLERY_RESIZE);

    expect(resized).not.toBeNull();
    expect(resized?.type).toBe("image/jpeg");
    expect(resized?.name).toBe("IMG_0001.jpg");
    expect(resized?.size).toBe(4321);
    expect(fake.encodes).toEqual([{ type: "image/jpeg", quality: 0.92 }]);
    // One decode at the reduced width: the full 200 MP bitmap never exists.
    expect(fake.decodeWidths).toHaveLength(1);
    expect(fake.decodeWidths[0]).toBeLessThan(5000);
    const [draw] = fake.draws;
    expect(draw && draw.width * draw.height).toBeLessThanOrEqual(16_000_000);
    expect(fake.closed).toBe(1);
  });

  it("falls back to a full decode when the decoder refuses the resize options", async () => {
    const fake = stubImagePipeline({ width: 9000, height: 6000 }, { noResizeOptions: true });
    const resized = await shrinkImageIfNeeded(pngOfSize(9000, 6000), GALLERY_RESIZE);

    expect(resized?.type).toBe("image/jpeg");
    expect(fake.decodeWidths).toEqual([null]);
    const [draw] = fake.draws;
    expect(draw && draw.width * draw.height).toBeLessThanOrEqual(16_000_000);
  });

  it("uploads the original 48 MP photo when the canvas can't be created (iOS area cap)", async () => {
    stubImagePipeline({ width: 8064, height: 6048 }, { canvasFails: true });

    expect(await shrinkImageIfNeeded(pngOfSize(8064, 6048), GALLERY_RESIZE)).toBeNull();
  });

  it("uploads the original when decoding a photo within the server cap fails", async () => {
    stubImagePipeline("fail");

    expect(await shrinkImageIfNeeded(pngOfSize(8064, 6048), GALLERY_RESIZE)).toBeNull();
  });

  it("gives a clear Spanish error when an over-cap photo can't be resized", async () => {
    stubImagePipeline({ width: 16320, height: 12240 }, { canvasFails: true });

    await expect(shrinkImageIfNeeded(pngOfSize(16320, 12240), GALLERY_RESIZE)).rejects.toThrow("No pudimos leer esta foto");
  });

  it("leaves a photo within the limit untouched without decoding it", async () => {
    stubImagePipeline({ width: 4000, height: 3000 });
    const original = pngOfSize(4000, 3000);

    expect(await shrinkImageIfNeeded(original, GALLERY_RESIZE)).toBeNull();
    expect(createImageBitmap).not.toHaveBeenCalled();
  });

  it("decodes when the header is unknown, then keeps a small image as is", async () => {
    const fake = stubImagePipeline({ width: 800, height: 600 });

    expect(await shrinkImageIfNeeded(new File(["x"], "rara.webp", { type: "image/webp" }), AVATAR_RESIZE)).toBeNull();
    expect(fake.encodes).toEqual([]);
    expect(fake.closed).toBe(1);
  });

  it("scales an avatar to 2048 px on the long edge", async () => {
    const fake = stubImagePipeline({ width: 6000, height: 8000 });
    const resized = await shrinkImageIfNeeded(pngOfSize(6000, 8000), AVATAR_RESIZE);

    expect(resized?.type).toBe("image/jpeg");
    expect(fake.draws).toEqual([{ width: 1536, height: 2048 }]);
    expect(fake.encodes).toEqual([{ type: "image/jpeg", quality: 0.9 }]);
  });

  it("throws a Spanish ImageDecodeError when an over-cap image can't be decoded", async () => {
    stubImagePipeline("fail");

    await expect(shrinkImageIfNeeded(pngOfSize(16000, 12000), GALLERY_RESIZE)).rejects.toThrow(ImageDecodeError);
    await expect(shrinkImageIfNeeded(pngOfSize(16000, 12000), GALLERY_RESIZE)).rejects.toThrow("No pudimos leer esta foto");
  });

  it("throws for an undecodable file of unknown size, but uploads it when only the canvas fails", async () => {
    stubImagePipeline("fail");
    await expect(shrinkImageIfNeeded(new File(["x"], "rara.webp", { type: "image/webp" }), GALLERY_RESIZE)).rejects.toThrow(ImageDecodeError);

    vi.unstubAllGlobals();
    stubImagePipeline({ width: 9000, height: 6000 }, { canvasFails: true });
    expect(await shrinkImageIfNeeded(new File(["x"], "rara.webp", { type: "image/webp" }), GALLERY_RESIZE)).toBeNull();
  });

  it("without createImageBitmap, uploads the original within the cap and refuses one above it", async () => {
    expect(await shrinkImageIfNeeded(pngOfSize(8064, 6048), GALLERY_RESIZE)).toBeNull();
    await expect(shrinkImageIfNeeded(pngOfSize(16000, 12000), GALLERY_RESIZE)).rejects.toThrow(ImageDecodeError);
  });
});
