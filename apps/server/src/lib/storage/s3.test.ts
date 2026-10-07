import { describe, expect, it } from "vitest";
import { AppError } from "../errors.js";
import { isS3Configured, type S3Settings, S3Storage } from "./s3.js";

const settings: S3Settings = {
  S3_ENDPOINT: "https://us-east-1.linodeobjects.com",
  S3_REGION: "us-east-1",
  S3_BUCKET: "cuencada",
  S3_ACCESS_KEY_ID: "AKIATESTONLY",
  S3_SECRET_ACCESS_KEY: "test-secret-key-not-real"
};

describe("isS3Configured", () => {
  it("requires endpoint, bucket and both credentials", () => {
    expect(isS3Configured(settings)).toBe(true);
    expect(isS3Configured({ ...settings, S3_BUCKET: "" })).toBe(false);
    expect(isS3Configured({ ...settings, S3_SECRET_ACCESS_KEY: "" })).toBe(false);
  });
});

describe("S3Storage", () => {
  it("throws SERVICE_UNAVAILABLE from every method when S3 is not configured", async () => {
    const storage = new S3Storage({ ...settings, S3_ENDPOINT: "" });

    for (const call of [
      () => storage.presignPut({ key: "k", contentType: "image/jpeg", contentLength: 1 }),
      () => storage.presignGet({ key: "k" }),
      () => storage.head("k"),
      () => storage.getRange("k", 0, 15),
      () => storage.put({ key: "k", body: new Uint8Array([1]), contentType: "image/jpeg" }),
      () => storage.delete("k")
    ]) {
      const error = await call().catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(AppError);
      expect(error).toMatchObject({ code: "SERVICE_UNAVAILABLE" });
    }
  });

  it("presigns a PUT bound to content-type and content-length on the bucket host", async () => {
    const storage = new S3Storage(settings);

    const presigned = await storage.presignPut({
      key: "cuencadas/2026/media/abc.jpg",
      contentType: "image/jpeg",
      contentLength: 1234,
      expiresInSeconds: 120
    });

    const url = new URL(presigned.url);
    expect(url.origin).toBe("https://cuencada.us-east-1.linodeobjects.com");
    expect(url.pathname).toBe("/cuencadas/2026/media/abc.jpg");
    expect(url.searchParams.get("X-Amz-Expires")).toBe("120");
    expect(url.searchParams.get("X-Amz-SignedHeaders")?.split(";")).toEqual(
      expect.arrayContaining(["content-length", "content-type", "host"])
    );
    expect(presigned.requiredHeaders).toEqual({ "content-type": "image/jpeg" });
    expect(presigned.signed).toEqual({ contentType: "image/jpeg", contentLength: 1234 });
    expect(presigned.method).toBe("PUT");
    storage.destroy();
  });

  it("presigns a PUT without SDK checksum parameters, signing exactly content-length, content-type and host", async () => {
    const storage = new S3Storage(settings);

    const presigned = await storage.presignPut({ key: "a/b.jpg", contentType: "image/jpeg", contentLength: 10 });

    const url = new URL(presigned.url);
    const names = [...url.searchParams.keys()].map((name) => name.toLowerCase());
    expect(names.filter((name) => name.startsWith("x-amz-checksum-"))).toEqual([]);
    expect(names).not.toContain("x-amz-sdk-checksum-algorithm");
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe("content-length;content-type;host");
    storage.destroy();
  });

  it("derives the signing date and expiresAt from the injected clock", async () => {
    const fixed = new Date("2026-10-06T12:00:00Z");
    const storage = new S3Storage(settings, { now: () => fixed });

    const put = await storage.presignPut({ key: "k", contentType: "image/png", contentLength: 1, expiresInSeconds: 60 });
    const get = await storage.presignGet({ key: "k", expiresInSeconds: 3600 });

    expect(put.expiresAt.toISOString()).toBe("2026-10-06T12:01:00.000Z");
    expect(get.expiresAt.toISOString()).toBe("2026-10-06T13:00:00.000Z");
    expect(new URL(put.url).searchParams.get("X-Amz-Date")).toBe("20261006T120000Z");
    storage.destroy();
  });

  it("presigns a GET with a content-disposition override and clamps the lifetime", async () => {
    const storage = new S3Storage(settings);

    const presigned = await storage.presignGet({
      key: "a/b.jpg",
      expiresInSeconds: 10 * 24 * 60 * 60,
      responseContentDisposition: 'attachment; filename="foto.jpg"'
    });

    const url = new URL(presigned.url);
    expect(url.searchParams.get("X-Amz-Expires")).toBe(String(24 * 60 * 60));
    expect(url.searchParams.get("response-content-disposition")).toBe('attachment; filename="foto.jpg"');
    storage.destroy();
  });

  it("rejects an invalid byte range before calling S3", async () => {
    const storage = new S3Storage(settings);

    await expect(storage.getRange("k", 10, 5)).rejects.toBeInstanceOf(RangeError);
    await expect(storage.getRange("k", -1, 5)).rejects.toBeInstanceOf(RangeError);
  });
});
