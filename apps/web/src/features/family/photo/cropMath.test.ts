import { describe, expect, it } from "vitest";
import {
  CROP_MAX_ZOOM,
  CROP_MIN_ZOOM,
  INITIAL_CROP_VIEW,
  clampView,
  cropSpecFor,
  panView,
  pinchGeometry,
  rotateView,
  viewScale,
  zoomView
} from "./cropMath";

const landscape = { width: 400, height: 200 };
const square = { width: 300, height: 300 };

describe("viewScale", () => {
  it("covers the viewport with the shorter side at zoom 1, honouring rotation", () => {
    expect(viewScale(landscape, { rotation: 0, zoom: 1 })).toBeCloseTo(1 / 200);
    expect(viewScale(landscape, { rotation: 90, zoom: 2 })).toBeCloseTo(2 / 200);
  });
});

describe("clampView", () => {
  it("keeps the image covering the viewport: no vertical pan at zoom 1 on a landscape image", () => {
    const view = clampView(landscape, { rotation: 0, zoom: 1, offsetX: 5, offsetY: 5 });
    // Displayed 2 × 1 viewport units: x may move ±0.5, y not at all.
    expect(view.offsetX).toBeCloseTo(0.5);
    expect(view.offsetY).toBe(0);
  });

  it("clamps zoom to its range and resets non-finite values", () => {
    expect(clampView(square, { rotation: 0, zoom: 99, offsetX: 0, offsetY: 0 }).zoom).toBe(CROP_MAX_ZOOM);
    expect(clampView(square, { rotation: 0, zoom: 0.1, offsetX: 0, offsetY: 0 }).zoom).toBe(CROP_MIN_ZOOM);
    expect(clampView(square, { rotation: 0, zoom: Number.NaN, offsetX: Number.POSITIVE_INFINITY, offsetY: Number.NaN })).toEqual({
      rotation: 0,
      zoom: CROP_MIN_ZOOM,
      offsetX: 0,
      offsetY: 0
    });
  });

  it("allows panning up to the edge once zoomed", () => {
    const view = clampView(square, { rotation: 0, zoom: 3, offsetX: -10, offsetY: 10 });
    expect(view.offsetX).toBeCloseTo(-1);
    expect(view.offsetY).toBeCloseTo(1);
  });
});

describe("panView", () => {
  it("adds the delta and clamps", () => {
    const zoomed = { ...INITIAL_CROP_VIEW, zoom: 2 };
    expect(panView(square, zoomed, 0.1, -0.2)).toMatchObject({ offsetX: 0.1, offsetY: -0.2 });
    expect(panView(square, zoomed, 3, 0).offsetX).toBeCloseTo(0.5);
  });
});

describe("zoomView", () => {
  it("keeps the anchor point fixed while zooming", () => {
    const anchor = { x: 0.25, y: -0.25 };
    const before = { ...INITIAL_CROP_VIEW, zoom: 2 };
    const after = zoomView(square, before, 4, anchor);
    // The image point under the anchor: (anchor − offset) / scale is unchanged.
    const imagePoint = (view: typeof before) => ({
      x: (anchor.x - view.offsetX) / viewScale(square, view),
      y: (anchor.y - view.offsetY) / viewScale(square, view)
    });
    expect(imagePoint(after).x).toBeCloseTo(imagePoint(before).x);
    expect(imagePoint(after).y).toBeCloseTo(imagePoint(before).y);
    expect(after.zoom).toBe(4);
  });

  it("re-clamps the offset when zooming out", () => {
    const panned = panView(square, { ...INITIAL_CROP_VIEW, zoom: 3 }, 1, 1);
    expect(zoomView(square, panned, 1)).toEqual({ ...INITIAL_CROP_VIEW });
  });

  it("ignores a non-finite target", () => {
    expect(zoomView(square, { ...INITIAL_CROP_VIEW, zoom: 2 }, Number.NaN).zoom).toBe(2);
  });
});

describe("rotateView", () => {
  it("cycles through quarter turns and turns the offset with the image", () => {
    const start = panView(landscape, INITIAL_CROP_VIEW, 0.3, 0);
    const turned = rotateView(landscape, start);
    expect(turned.rotation).toBe(90);
    // (x, y) → (−y, x): the horizontal offset becomes vertical; the rotated image is 1 × 2, so 0.3 fits.
    expect(turned.offsetX).toBeCloseTo(0);
    expect(turned.offsetY).toBeCloseTo(0.3);
    let view = turned;
    for (const expected of [180, 270, 0]) {
      view = rotateView(landscape, view);
      expect(view.rotation).toBe(expected);
    }
  });
});

describe("cropSpecFor", () => {
  it("is the centred square of the shorter side at the initial view", () => {
    const spec = cropSpecFor(landscape, INITIAL_CROP_VIEW);
    expect(spec.rotation).toBe(0);
    expect(spec.x).toBeCloseTo(0.25);
    expect(spec.y).toBeCloseTo(0);
    expect(spec.width).toBeCloseTo(0.5);
    expect(spec.height).toBeCloseTo(1);
  });

  it("follows pan and zoom: zoom 2 panned fully left shows the right quarter", () => {
    const view = panView(square, { ...INITIAL_CROP_VIEW, zoom: 2 }, -10, 0);
    const spec = cropSpecFor(square, view);
    expect(spec.width).toBeCloseTo(0.5);
    expect(spec.x).toBeCloseTo(0.5);
    expect(spec.y).toBeCloseTo(0.25);
  });

  it("is expressed in the rotated image after a quarter turn", () => {
    const spec = cropSpecFor(landscape, rotateView(landscape, INITIAL_CROP_VIEW));
    // Rotated: 200 wide × 400 tall; the centred 200 px square.
    expect(spec).toMatchObject({ rotation: 90 });
    expect(spec.x).toBeCloseTo(0);
    expect(spec.y).toBeCloseTo(0.25);
    expect(spec.width).toBeCloseTo(1);
    expect(spec.height).toBeCloseTo(0.5);
  });

  it("always stays inside the image, whatever the view", () => {
    for (const offsetX of [-5, -0.3, 0, 0.7, 5]) {
      for (const zoom of [1, 1.7, 5]) {
        const spec = cropSpecFor(landscape, { rotation: 270, zoom, offsetX, offsetY: -offsetX });
        expect(spec.x).toBeGreaterThanOrEqual(-1e-9);
        expect(spec.y).toBeGreaterThanOrEqual(-1e-9);
        expect(spec.x + spec.width).toBeLessThanOrEqual(1 + 1e-9);
        expect(spec.y + spec.height).toBeLessThanOrEqual(1 + 1e-9);
      }
    }
  });
});

describe("pinchGeometry", () => {
  it("returns the distance and midpoint of two pointers", () => {
    expect(pinchGeometry({ x: 0, y: 0 }, { x: 0.3, y: 0.4 })).toEqual({ distance: 0.5, mid: { x: 0.15, y: 0.2 } });
  });
});

describe("16:9 frame (WP-5.4 event covers)", () => {
  const wide = 16 / 9;
  const photo = { width: 4000, height: 3000 };
  const panorama = { width: 3200, height: 1000 };

  it("covers the wide frame at zoom 1: the width fills it for a 4:3 photo, the height for a panorama", () => {
    // 4:3 is taller than 16:9, so the width is the limiting side: 16/9 units over 4000 px.
    expect(viewScale(photo, { rotation: 0, zoom: 1 }, wide)).toBeCloseTo(wide / 4000);
    // 3.2:1 is wider than 16:9, so the height fills the frame.
    expect(viewScale(panorama, { rotation: 0, zoom: 1 }, wide)).toBeCloseTo(1 / 1000);
  });

  it("pans only along the spare axis at zoom 1", () => {
    const view = clampView(photo, { rotation: 0, zoom: 1, offsetX: 5, offsetY: 5 }, wide);
    expect(view.offsetX).toBe(0);
    // Displayed height: 3000 × (16/9)/4000 = 4/3 units, so ±(4/3 − 1)/2.
    expect(view.offsetY).toBeCloseTo((4 / 3 - 1) / 2);
  });

  it("crops a 16:9 region in pixels, centred at zoom 1", () => {
    const spec = cropSpecFor(photo, INITIAL_CROP_VIEW, wide);
    const widthPx = spec.width * photo.width;
    const heightPx = spec.height * photo.height;
    expect(widthPx / heightPx).toBeCloseTo(wide);
    expect(widthPx).toBeCloseTo(4000);
    expect(heightPx).toBeCloseTo(2250);
    expect(spec.x).toBeCloseTo(0);
    expect(spec.y * photo.height).toBeCloseTo((3000 - 2250) / 2);
  });

  it("keeps 16:9 after zooming, panning to the edge and rotating", () => {
    let view = zoomView(photo, INITIAL_CROP_VIEW, 2, undefined, wide);
    view = panView(photo, view, -10, 10, wide);
    let spec = cropSpecFor(photo, view, wide);
    expect((spec.width * photo.width) / (spec.height * photo.height)).toBeCloseTo(wide);
    // Panned fully left and up (offset negative x → image moves left → crop at the right edge; +y → top edge).
    expect(spec.x + spec.width).toBeCloseTo(1);
    expect(spec.y).toBeCloseTo(0);
    view = rotateView(photo, view, wide);
    spec = cropSpecFor(photo, view, wide);
    // Rotated: the rotated image is 3000 × 4000.
    expect((spec.width * 3000) / (spec.height * 4000)).toBeCloseTo(wide);
    expect(spec.x).toBeGreaterThanOrEqual(-1e-9);
    expect(spec.x + spec.width).toBeLessThanOrEqual(1 + 1e-9);
    expect(spec.y).toBeGreaterThanOrEqual(-1e-9);
    expect(spec.y + spec.height).toBeLessThanOrEqual(1 + 1e-9);
  });

  it("treats a non-finite or non-positive aspect as a square", () => {
    expect(cropSpecFor(square, INITIAL_CROP_VIEW, 0)).toEqual(cropSpecFor(square, INITIAL_CROP_VIEW));
    expect(viewScale(landscape, { rotation: 0, zoom: 1 }, Number.NaN)).toBeCloseTo(1 / 200);
  });
});
