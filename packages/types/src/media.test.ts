import { describe, expect, it } from "vitest";
import { createUploadInputSchema, maxBytesForMime, MEDIA_SIZE_LIMITS, mediaKindOfMime } from "./media.js";
import { avatarUploadInputSchema } from "./profile.js";

const MB = 1024 * 1024;

describe("mediaKindOfMime", () => {
  it("classifies mp4 as video and the rest as images", () => {
    expect(mediaKindOfMime("video/mp4")).toBe("video");
    expect(mediaKindOfMime("image/heic")).toBe("image");
    expect(maxBytesForMime("image/jpeg")).toBe(MEDIA_SIZE_LIMITS.image);
  });
});

describe("createUploadInputSchema", () => {
  it("accepts an image at exactly 25 MB", () => {
    const parsed = createUploadInputSchema.parse({ fileName: "IMG_0001.HEIC", mimeType: "image/heic", byteSize: 25 * MB });
    expect(parsed.caption).toBeNull();
  });

  it("rejects an image over 25 MB on byteSize", () => {
    const result = createUploadInputSchema.safeParse({ fileName: "a.jpg", mimeType: "image/jpeg", byteSize: 25 * MB + 1 });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["byteSize"]);
  });

  it("accepts a video at 300 MB and rejects one byte more", () => {
    expect(createUploadInputSchema.safeParse({ fileName: "v.mp4", mimeType: "video/mp4", byteSize: 300 * MB }).success).toBe(true);
    expect(createUploadInputSchema.safeParse({ fileName: "v.mp4", mimeType: "video/mp4", byteSize: 300 * MB + 1 }).success).toBe(false);
  });

  it("rejects MIME types outside the allowlist", () => {
    for (const mimeType of ["image/gif", "image/svg+xml", "video/quicktime", "text/html", "application/pdf"]) {
      expect(createUploadInputSchema.safeParse({ fileName: "x", mimeType, byteSize: 10 }).success).toBe(false);
    }
  });

  it("rejects zero, negative and fractional sizes", () => {
    for (const byteSize of [0, -1, 1.5]) {
      expect(createUploadInputSchema.safeParse({ fileName: "a.png", mimeType: "image/png", byteSize }).success).toBe(false);
    }
  });

  it("rejects file names with path separators or control characters", () => {
    for (const fileName of ["../etc/passwd", "a\\b.jpg", "a\u0000.jpg", ""]) {
      expect(createUploadInputSchema.safeParse({ fileName, mimeType: "image/png", byteSize: 10 }).success).toBe(false);
    }
  });
});

describe("avatarUploadInputSchema", () => {
  it("accepts images up to 10 MB and rejects video", () => {
    expect(avatarUploadInputSchema.safeParse({ mimeType: "image/webp", byteSize: 10 * MB }).success).toBe(true);
    expect(avatarUploadInputSchema.safeParse({ mimeType: "image/webp", byteSize: 10 * MB + 1 }).success).toBe(false);
    expect(avatarUploadInputSchema.safeParse({ mimeType: "video/mp4", byteSize: 10 }).success).toBe(false);
  });
});
