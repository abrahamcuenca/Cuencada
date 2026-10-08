import { describe, expect, it, vi } from "vitest";
import { applyAffine, type CropContext, cropPixels, drawSquareCrop, rotatedSize, rotationMatrix } from "./cropCore";

describe("rotationMatrix", () => {
  const width = 400;
  const height = 200;

  it.each([
    [0, { x: 0, y: 0 }, { x: 399, y: 199 }],
    [90, { x: 199, y: 0 }, { x: 0, y: 399 }],
    [180, { x: 399, y: 199 }, { x: 0, y: 0 }],
    [270, { x: 0, y: 399 }, { x: 199, y: 0 }]
  ] as const)("maps the corners for a %i° clockwise turn", (rotation, topLeft, bottomRight) => {
    const matrix = rotationMatrix(rotation, width, height);
    // Pixel centres: map (0.5, 0.5) and (399.5, 199.5), then floor.
    const a = applyAffine(matrix, 0.5, 0.5);
    const b = applyAffine(matrix, width - 0.5, height - 0.5);
    expect({ x: Math.floor(a.x), y: Math.floor(a.y) }).toEqual(topLeft);
    expect({ x: Math.floor(b.x), y: Math.floor(b.y) }).toEqual(bottomRight);
    const size = rotatedSize(width, height, rotation);
    for (const point of [a, b]) {
      expect(point.x).toBeGreaterThanOrEqual(0);
      expect(point.x).toBeLessThanOrEqual(size.width);
      expect(point.y).toBeLessThanOrEqual(size.height);
    }
  });
});

describe("cropPixels", () => {
  it("scales fractions to the decoded, rotated size", () => {
    expect(cropPixels({ rotation: 90, x: 0, y: 0.25, width: 1, height: 0.5 }, 4000, 2000)).toEqual({ x: 0, y: 1000, width: 2000, height: 2000 });
  });

  it("clamps out-of-range or non-finite fractions inside the image", () => {
    const crop = cropPixels({ rotation: 0, x: 1.2, y: Number.NaN, width: 2, height: -1 }, 100, 50);
    expect(crop.x + crop.width).toBeLessThanOrEqual(100);
    expect(crop.y).toBe(0);
    expect(crop.height).toBeGreaterThanOrEqual(1);
  });
});

describe("drawSquareCrop", () => {
  it("paints white, then scales the crop to the output and applies the rotation", () => {
    const calls: string[] = [];
    const context = {
      fillStyle: "",
      imageSmoothingEnabled: false,
      imageSmoothingQuality: "low",
      setTransform: vi.fn(() => calls.push("setTransform")),
      fillRect: vi.fn(() => calls.push("fillRect")),
      scale: vi.fn(() => calls.push("scale")),
      translate: vi.fn(() => calls.push("translate")),
      transform: vi.fn(() => calls.push("transform")),
      drawImage: vi.fn(() => calls.push("drawImage"))
    };
    const source = {} as CanvasImageSource; // Safe: the mocked drawImage never reads it.
    drawSquareCrop(context as unknown as CropContext, source, { width: 400, height: 200 }, { rotation: 90, x: 0, y: 0.25, width: 1, height: 0.5 }, 1024);
    expect(calls).toEqual(["setTransform", "fillRect", "scale", "translate", "transform", "drawImage"]);
    expect(context.fillStyle).toBe("#ffffff");
    expect(context.scale).toHaveBeenCalledWith(1024 / 200, 1024 / 200);
    expect(context.translate).toHaveBeenCalledWith(-0, -100);
    expect(context.transform).toHaveBeenCalledWith(0, 1, -1, 0, 200, 0);
    expect(context.drawImage).toHaveBeenCalledWith(source, 0, 0, 400, 200);
  });
});
