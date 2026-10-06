import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeXhr, SIGNED_PUT_URL } from "../testUtils";
import { putToPresignedUrl, sendableHeaders, UploadTransferError } from "./putToPresignedUrl";

function lastXhr(): FakeXhr {
  const xhr = FakeXhr.instances.at(-1);
  if (!xhr) throw new Error("no XHR sent");
  return xhr;
}

beforeEach(() => {
  FakeXhr.instances = [];
  vi.stubGlobal("XMLHttpRequest", FakeXhr);
});
afterEach(() => vi.unstubAllGlobals());

describe("sendableHeaders", () => {
  it("drops Content-Length, Host and Authorization but keeps the signed type", () => {
    expect(sendableHeaders({ "Content-Type": "image/jpeg", "content-length": "10", Host: "x", Authorization: "Bearer t", "x-amz-acl": "private" })).toEqual([
      ["Content-Type", "image/jpeg"],
      ["x-amz-acl", "private"]
    ]);
  });
});

describe("putToPresignedUrl", () => {
  it("PUTs the body with only the sendable headers, without credentials, and reports progress", async () => {
    const onProgress = vi.fn();
    const body = new Blob(["abc"]);
    const done = putToPresignedUrl({
      url: SIGNED_PUT_URL,
      headers: { "Content-Type": "image/jpeg", "Content-Length": "3" },
      body,
      signal: new AbortController().signal,
      onProgress
    });
    const xhr = lastXhr();
    expect(xhr.method).toBe("PUT");
    expect(xhr.url).toBe(SIGNED_PUT_URL);
    expect(xhr.headers).toEqual({ "Content-Type": "image/jpeg" });
    expect(xhr.withCredentials).toBe(false);
    expect(xhr.body).toBe(body);

    xhr.progress(1, 2);
    expect(onProgress).toHaveBeenLastCalledWith(0.5);
    xhr.respond(200);
    await expect(done).resolves.toBeUndefined();
    expect(onProgress).toHaveBeenLastCalledWith(1);
  });

  it("rejects a 403 as expired with a message that never contains the URL", async () => {
    const done = putToPresignedUrl({ url: SIGNED_PUT_URL, headers: {}, body: new Blob(["a"]), signal: new AbortController().signal, onProgress: () => {} });
    lastXhr().respond(403);
    const error = await done.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UploadTransferError);
    expect(error).toMatchObject({ failure: "expired", status: 403 });
    expect(error instanceof UploadTransferError && error.message).not.toContain("bucket.example");
  });

  it("rejects a network error and a 5xx with retryable messages", async () => {
    const network = putToPresignedUrl({ url: SIGNED_PUT_URL, headers: {}, body: new Blob(["a"]), signal: new AbortController().signal, onProgress: () => {} });
    lastXhr().fail();
    await expect(network).rejects.toMatchObject({ failure: "network" });

    const server = putToPresignedUrl({ url: SIGNED_PUT_URL, headers: {}, body: new Blob(["a"]), signal: new AbortController().signal, onProgress: () => {} });
    lastXhr().respond(503);
    await expect(server).rejects.toMatchObject({ failure: "unavailable" });
  });

  it("aborts the XHR when the signal fires", async () => {
    const controller = new AbortController();
    const done = putToPresignedUrl({ url: SIGNED_PUT_URL, headers: {}, body: new Blob(["a"]), signal: controller.signal, onProgress: () => {} });
    controller.abort();
    await expect(done).rejects.toMatchObject({ name: "AbortError", failure: "aborted" });
    expect(lastXhr().aborted).toBe(true);
  });
});
