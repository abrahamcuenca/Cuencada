/**
 * Square (WP-4.3) or fixed-aspect (WP-5.4 event covers, 16:9) crop with a
 * quarter-turn rotation, drawn onto a canvas.
 * Pure geometry plus one draw call, shared by the resize worker and the
 * main-thread fallback (see `resizeImage.ts`). No React, no store.
 *
 * The crop is expressed in **fractions of the rotated image** (0..1), so it
 * applies unchanged to a preview decoded at one size in the cropper and to
 * the image decoded at another size in the worker.
 */

/** Clockwise quarter turns, in degrees. */
export type QuarterTurn = 0 | 90 | 180 | 270;

/**
 * A crop of the image after `rotation`, in fractions of the rotated
 * width/height. The name predates WP-5.4: the crop is square for avatars and
 * `aspect : 1` in pixels for covers (see `cropSpecFor`).
 */
export interface SquareCropSpec {
  rotation: QuarterTurn;
  /** Left edge / rotated width. */
  x: number;
  /** Top edge / rotated height. */
  y: number;
  /** Crop width / rotated width. */
  width: number;
  /** Crop height / rotated height (the same pixel side as `width` for a square crop). */
  height: number;
}

/** Alias of {@link SquareCropSpec} for crops of any aspect ratio. */
export type CropSpec = SquareCropSpec;

/** Output canvas size of a crop, in pixels. */
export interface CropOutputSize {
  width: number;
  height: number;
}

/** A 2D affine matrix in canvas `transform(a, b, c, d, e, f)` order. */
export type Affine = readonly [number, number, number, number, number, number];

/**
 * The image's size after `rotation`.
 *
 * @param width - Unrotated width.
 * @param height - Unrotated height.
 * @param rotation - Clockwise quarter turns.
 */
export function rotatedSize(width: number, height: number, rotation: QuarterTurn): { width: number; height: number } {
  return rotation === 90 || rotation === 270 ? { width: height, height: width } : { width, height };
}

/**
 * The matrix that maps a point of the unrotated image (`x`, `y`) to the
 * rotated image, whose origin is its own top-left corner:
 * `x' = a·x + c·y + e`, `y' = b·x + d·y + f`.
 *
 * @param rotation - Clockwise quarter turns.
 * @param width - Unrotated width.
 * @param height - Unrotated height.
 */
export function rotationMatrix(rotation: QuarterTurn, width: number, height: number): Affine {
  switch (rotation) {
    case 90:
      return [0, 1, -1, 0, height, 0];
    case 180:
      return [-1, 0, 0, -1, width, height];
    case 270:
      return [0, -1, 1, 0, 0, width];
    default:
      return [1, 0, 0, 1, 0, 0];
  }
}

/**
 * Apply an affine matrix to a point (tests and the cropper's hit maths).
 *
 * @param matrix - From {@link rotationMatrix}.
 * @param x - X.
 * @param y - Y.
 */
export function applyAffine(matrix: Affine, x: number, y: number): { x: number; y: number } {
  const [a, b, c, d, e, f] = matrix;
  return { x: a * x + c * y + e, y: b * x + d * y + f };
}

/**
 * The crop in pixels of the rotated image of `width × height`, kept inside
 * it (a fraction slightly out of range from float error is clamped).
 *
 * @param spec - The crop.
 * @param width - Unrotated width of the decoded image.
 * @param height - Unrotated height of the decoded image.
 */
export function cropPixels(spec: SquareCropSpec, width: number, height: number): { x: number; y: number; width: number; height: number } {
  const rotated = rotatedSize(width, height, spec.rotation);
  const clamp01 = (value: number): number => (Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0);
  const cropWidth = Math.max(1, clamp01(spec.width) * rotated.width);
  const cropHeight = Math.max(1, clamp01(spec.height) * rotated.height);
  return {
    x: Math.min(clamp01(spec.x) * rotated.width, rotated.width - cropWidth),
    y: Math.min(clamp01(spec.y) * rotated.height, rotated.height - cropHeight),
    width: cropWidth,
    height: cropHeight
  };
}

/** The 2D context calls {@link drawSquareCrop} needs (canvas or OffscreenCanvas). */
export type CropContext = Pick<
  CanvasRenderingContext2D,
  "setTransform" | "scale" | "translate" | "transform" | "drawImage" | "fillRect" | "imageSmoothingEnabled" | "imageSmoothingQuality"
> & { fillStyle: string | CanvasGradient | CanvasPattern };

/**
 * Draw `source` rotated and cropped so the crop fills an `output.width ×
 * output.height` canvas. The background is painted white first (transparent
 * PNGs become JPEG without a black background).
 *
 * @param context - The output canvas' 2D context.
 * @param source - The decoded image (EXIF orientation already applied).
 * @param sourceSize - Its unrotated size.
 * @param spec - The crop.
 * @param output - Output size in pixels.
 */
export function drawCrop(
  context: CropContext,
  source: CanvasImageSource,
  sourceSize: { width: number; height: number },
  spec: CropSpec,
  output: CropOutputSize
): void {
  const crop = cropPixels(spec, sourceSize.width, sourceSize.height);
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, output.width, output.height);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.scale(output.width / crop.width, output.height / crop.height);
  context.translate(-crop.x, -crop.y);
  context.transform(...rotationMatrix(spec.rotation, sourceSize.width, sourceSize.height));
  context.drawImage(source, 0, 0, sourceSize.width, sourceSize.height);
}

/**
 * {@link drawCrop} onto a square `output × output` canvas (WP-4.3 avatars).
 *
 * @param context - The output canvas' 2D context.
 * @param source - The decoded image (EXIF orientation already applied).
 * @param sourceSize - Its unrotated size.
 * @param spec - The crop.
 * @param output - Output side in pixels.
 */
export function drawSquareCrop(
  context: CropContext,
  source: CanvasImageSource,
  sourceSize: { width: number; height: number },
  spec: SquareCropSpec,
  output: number
): void {
  drawCrop(context, source, sourceSize, spec, { width: output, height: output });
}
