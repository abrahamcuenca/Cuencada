/**
 * Test helpers for the client-side downscale: tiny files whose headers claim
 * a given pixel size, and fakes for `createImageBitmap` / `OffscreenCanvas`
 * (jsdom has neither). Tests only.
 */
import { vi } from "vitest";

/** A PNG whose IHDR claims `width × height` (no pixel data: only the header is read). */
export function pngOfSize(width: number, height: number, name = "foto.png"): File {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(bytes.buffer).setUint32(16, width);
  new DataView(bytes.buffer).setUint32(20, height);
  return new File([bytes], name, { type: "image/png" });
}

/** A JPEG with an APP0 segment then a SOF0 claiming `width × height`. */
export function jpegOfSize(width: number, height: number): Uint8Array {
  const app0 = [0xff, 0xe0, 0x00, 0x10, ...new Array<number>(14).fill(0)];
  const sof0 = [0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 3, ...new Array<number>(9).fill(0)];
  return new Uint8Array([0xff, 0xd8, ...app0, ...sof0, 0xff, 0xd9]);
}

/** What the fakes recorded. */
export interface ImagePipelineFake {
  /** Sizes passed to `drawImage` (target width × height). */
  draws: Array<{ width: number; height: number }>;
  /** Options passed to `convertToBlob`. */
  encodes: Array<{ type?: string; quality?: number }>;
  /** Bitmaps closed. */
  closed: number;
  /** Size of the re-encoded blob. */
  outputBytes: number;
}

/**
 * Installs fake `createImageBitmap` (decoding to `decoded`, or failing) and
 * `OffscreenCanvas` globals. Undo with `vi.unstubAllGlobals()`.
 *
 * @param decoded - The decoded size, or `"fail"` to reject like a corrupt file.
 * @param outputBytes - Size of the fake re-encoded JPEG.
 * @returns The recorder.
 */
export function stubImagePipeline(decoded: { width: number; height: number } | "fail", outputBytes = 1234): ImagePipelineFake {
  const fake: ImagePipelineFake = { draws: [], encodes: [], closed: 0, outputBytes };
  vi.stubGlobal(
    "createImageBitmap",
    vi.fn(async () => {
      if (decoded === "fail") throw new DOMException("The source image could not be decoded.", "InvalidStateError");
      return {
        width: decoded.width,
        height: decoded.height,
        close: () => {
          fake.closed += 1;
        }
      };
    })
  );
  vi.stubGlobal(
    "OffscreenCanvas",
    class {
      width: number;
      height: number;
      constructor(width: number, height: number) {
        this.width = width;
        this.height = height;
      }
      getContext(): unknown {
        return {
          imageSmoothingEnabled: false,
          imageSmoothingQuality: "low",
          drawImage: (_image: unknown, _x: number, _y: number, width: number, height: number) => fake.draws.push({ width, height })
        };
      }
      convertToBlob(options: { type?: string; quality?: number }): Promise<Blob> {
        fake.encodes.push(options);
        return Promise.resolve(new Blob([new Uint8Array(fake.outputBytes)], { type: options.type ?? "image/png" }));
      }
    }
  );
  return fake;
}
