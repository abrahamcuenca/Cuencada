/**
 * Pure maths of the `ImageCropper` view (WP-4.3): pan and zoom clamps,
 * anchored zoom, quarter-turn rotation and the output crop.
 *
 * Units: the viewport is **`aspect` × 1** (width × height; `aspect` = 1 for
 * the square avatar crop, 16/9 for event covers, WP-5.4), its centre the
 * origin, so one unit is always the viewport's height. The image (already
 * rotated) is drawn centred at `offset`, at `scale` viewport units per image
 * pixel. At zoom 1 it just covers the viewport ("cover"), so the crop is
 * never empty; panning is clamped so it stays covered.
 *
 * Every function takes `aspect` last and defaults it to 1, so the square
 * behaviour (and its callers) is unchanged.
 */
import { type QuarterTurn, rotatedSize, type SquareCropSpec } from "../../gallery/lib/cropCore";

/** Smallest and largest zoom (1 = the shorter side fills the frame). */
export const CROP_MIN_ZOOM = 1;
export const CROP_MAX_ZOOM = 5;
/** Zoom step of the buttons and `+`/`-` keys. */
export const CROP_ZOOM_STEP = 0.25;
/** Arrow-key pan step, in viewport units (Shift: ×4). */
export const CROP_PAN_STEP = 0.02;

/** Source image size before rotation (px). */
export interface ImageDims {
  width: number;
  height: number;
}

/** The cropper's view state. */
export interface CropView {
  rotation: QuarterTurn;
  /** {@link CROP_MIN_ZOOM}..{@link CROP_MAX_ZOOM}. */
  zoom: number;
  /** Image centre relative to the viewport centre (viewport units). */
  offsetX: number;
  offsetY: number;
}

/** The initial view: no rotation, cover, centred. */
export const INITIAL_CROP_VIEW: CropView = { rotation: 0, zoom: 1, offsetX: 0, offsetY: 0 };

/** Square crop (avatars, tree photos). */
export const SQUARE_ASPECT = 1;

/**
 * A usable aspect ratio: finite and positive, else 1 (square).
 *
 * @param aspect - Width / height of the crop frame.
 */
export function safeAspect(aspect: number): number {
  return Number.isFinite(aspect) && aspect > 0 ? aspect : SQUARE_ASPECT;
}

/**
 * Viewport units per image pixel for `view`: at zoom 1 the image just covers
 * the `aspect × 1` frame (for a square, its shorter side fills it).
 *
 * @param image - Unrotated image size.
 * @param view - Rotation and zoom.
 * @param aspect - Frame width / height (default 1).
 */
export function viewScale(image: ImageDims, view: Pick<CropView, "rotation" | "zoom">, aspect = SQUARE_ASPECT): number {
  const rotated = rotatedSize(image.width, image.height, view.rotation);
  return view.zoom * Math.max(safeAspect(aspect) / rotated.width, 1 / rotated.height);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Clamp zoom to its range and the offset so the image still covers the
 * whole viewport (`|offsetX| ≤ (displayed width − aspect) / 2`,
 * `|offsetY| ≤ (displayed height − 1) / 2`). Non-finite values reset to the
 * centre / zoom 1.
 *
 * @param image - Unrotated image size.
 * @param view - Proposed view.
 * @param aspect - Frame width / height (default 1).
 */
export function clampView(image: ImageDims, view: CropView, aspect = SQUARE_ASPECT): CropView {
  const frame = safeAspect(aspect);
  const zoom = Number.isFinite(view.zoom) ? clamp(view.zoom, CROP_MIN_ZOOM, CROP_MAX_ZOOM) : CROP_MIN_ZOOM;
  const scale = viewScale(image, { rotation: view.rotation, zoom }, frame);
  const rotated = rotatedSize(image.width, image.height, view.rotation);
  const maxX = Math.max(0, (rotated.width * scale - frame) / 2);
  const maxY = Math.max(0, (rotated.height * scale - 1) / 2);
  return {
    rotation: view.rotation,
    zoom,
    offsetX: Number.isFinite(view.offsetX) ? clamp(view.offsetX, -maxX, maxX) : 0,
    offsetY: Number.isFinite(view.offsetY) ? clamp(view.offsetY, -maxY, maxY) : 0
  };
}

/**
 * Pan by a delta in viewport units, clamped.
 *
 * @param image - Unrotated image size.
 * @param view - Current view.
 * @param dx - Horizontal delta.
 * @param dy - Vertical delta.
 * @param aspect - Frame width / height (default 1).
 */
export function panView(image: ImageDims, view: CropView, dx: number, dy: number, aspect = SQUARE_ASPECT): CropView {
  return clampView(image, { ...view, offsetX: view.offsetX + dx, offsetY: view.offsetY + dy }, aspect);
}

/**
 * Zoom to `zoom`, keeping the image point under `anchor` (viewport units,
 * relative to the centre; default the centre) where it is, then clamp.
 *
 * @param image - Unrotated image size.
 * @param view - Current view.
 * @param zoom - Target zoom (clamped).
 * @param anchor - Fixed point, e.g. the pinch midpoint.
 * @param aspect - Frame width / height (default 1).
 */
export function zoomView(
  image: ImageDims,
  view: CropView,
  zoom: number,
  anchor: { x: number; y: number } = { x: 0, y: 0 },
  aspect = SQUARE_ASPECT
): CropView {
  const target = Number.isFinite(zoom) ? clamp(zoom, CROP_MIN_ZOOM, CROP_MAX_ZOOM) : view.zoom;
  const ratio = target / view.zoom;
  return clampView(
    image,
    {
      ...view,
      zoom: target,
      offsetX: anchor.x - (anchor.x - view.offsetX) * ratio,
      offsetY: anchor.y - (anchor.y - view.offsetY) * ratio
    },
    aspect
  );
}

/**
 * Rotate a quarter turn clockwise about the viewport centre: the offset
 * turns with the image (`(x, y) → (−y, x)`), zoom is kept, then clamped.
 *
 * @param image - Unrotated image size.
 * @param view - Current view.
 * @param aspect - Frame width / height (default 1).
 */
export function rotateView(image: ImageDims, view: CropView, aspect = SQUARE_ASPECT): CropView {
  const rotation = ((view.rotation + 90) % 360) as QuarterTurn; // Safe: a quarter turn plus 90, mod 360, is a quarter turn.
  return clampView(image, { rotation, zoom: view.zoom, offsetX: -view.offsetY, offsetY: view.offsetX }, aspect);
}

/**
 * The frame under the viewport, as fractions of the rotated image: what
 * `cropImageToSquare` (aspect 1) or `cropImageToRect` (e.g. a 16:9 cover)
 * renders. In pixels of the rotated image the crop is `aspect : 1`.
 *
 * @param image - Unrotated image size.
 * @param view - Current (clamped) view.
 * @param aspect - Frame width / height (default 1).
 */
export function cropSpecFor(image: ImageDims, view: CropView, aspect = SQUARE_ASPECT): SquareCropSpec {
  const frame = safeAspect(aspect);
  const clamped = clampView(image, view, frame);
  const scale = viewScale(image, clamped, frame);
  const rotated = rotatedSize(image.width, image.height, clamped.rotation);
  const width = frame / scale;
  const height = 1 / scale;
  const left = rotated.width / 2 - clamped.offsetX / scale - width / 2;
  const top = rotated.height / 2 - clamped.offsetY / scale - height / 2;
  return {
    rotation: clamped.rotation,
    x: left / rotated.width,
    y: top / rotated.height,
    width: width / rotated.width,
    height: height / rotated.height
  };
}

/**
 * Distance and midpoint of two pointers (pinch), in the units given.
 *
 * @param a - First pointer.
 * @param b - Second pointer.
 */
export function pinchGeometry(a: { x: number; y: number }, b: { x: number; y: number }): { distance: number; mid: { x: number; y: number } } {
  return { distance: Math.hypot(b.x - a.x, b.y - a.y), mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
}
