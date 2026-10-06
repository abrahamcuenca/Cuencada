import { describe, expect, it } from "vitest";
import { formatBytes, UPLOAD_ACCEPT, validateUploadFile } from "./validateFile";

const MB = 1024 * 1024;

function fileOf(name: string, type: string, size: number): File {
  const file = new File(["x"], name, { type });
  Object.defineProperty(file, "size", { value: size });
  return file;
}

describe("validateUploadFile", () => {
  it("accepts a JPEG at exactly the 25 MB image limit", () => {
    const result = validateUploadFile(fileOf("IMG_0001.JPG", "image/jpeg", 25 * MB));
    expect(result).toMatchObject({ ok: true, mimeType: "image/jpeg", kind: "image", fileName: "IMG_0001.JPG" });
  });

  it("rejects an image one byte over 25 MB", () => {
    const result = validateUploadFile(fileOf("big.png", "image/png", 25 * MB + 1));
    expect(result).toMatchObject({ ok: false, reason: "Esta foto pesa más de 25 MB." });
  });

  it("accepts a MOV video up to 300 MB and rejects one over it", () => {
    expect(validateUploadFile(fileOf("clip.mov", "video/quicktime", 300 * MB)).ok).toBe(true);
    const result = validateUploadFile(fileOf("clip.mov", "video/quicktime", 300 * MB + 1));
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("Este video pesa más de 300 MB") });
  });

  it("explains HEIC instead of uploading it", () => {
    const result = validateUploadFile(fileOf("IMG_2041.HEIC", "image/heic", MB));
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toContain("iPhone convierte automáticamente a JPG al subir desde el navegador");
  });

  it("rejects other types with the allowlist in Spanish", () => {
    const result = validateUploadFile(fileOf("notas.pdf", "application/pdf", 1000));
    expect(result).toMatchObject({ ok: false, reason: "Solo se pueden subir fotos (JPG, PNG o WebP) y videos (MP4 o MOV)." });
  });

  it("rejects an empty file", () => {
    expect(validateUploadFile(fileOf("vacia.jpg", "image/jpeg", 0))).toMatchObject({ ok: false, reason: "El archivo está vacío." });
  });

  it("infers the type from the extension when the OS reports none", () => {
    expect(validateUploadFile(fileOf("video.mp4", "", 10 * MB))).toMatchObject({ ok: true, mimeType: "video/mp4", kind: "video" });
    expect(validateUploadFile(fileOf("raro.xyz", "", 10)).ok).toBe(false);
  });

  it("replaces a name the contract would reject", () => {
    const result = validateUploadFile(fileOf("a\u0007b.jpg", "image/jpeg", 10));
    expect(result).toMatchObject({ ok: true, fileName: "archivo.jpg" });
  });
});

describe("UPLOAD_ACCEPT", () => {
  it("is exactly the contract allowlist", () => {
    expect(UPLOAD_ACCEPT).toBe("image/jpeg,image/png,image/webp,video/mp4,video/quicktime");
  });
});

describe("formatBytes", () => {
  it("formats kilobytes and megabytes", () => {
    expect(formatBytes(512)).toBe("1 KB");
    expect(formatBytes(3.45 * MB)).toBe("3.5 MB");
  });
});
