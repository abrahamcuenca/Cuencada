/**
 * `ImageCropper` (WP-4.3): a square canvas viewport with a circular mask
 * where the member frames a photo before it is uploaded. Lazy-loaded (no
 * new dependency): Pointer Events for drag and pinch, a zoom slider and
 * buttons, a 90° rotate button, and the keyboard (arrows pan, `+`/`-` zoom,
 * `R` rotates). It never animates on its own, so `prefers-reduced-motion`
 * only affects the CSS transitions of its buttons.
 *
 * The result is a 1024×1024 JPEG made by the gallery's resize worker (main
 * thread fallback), without metadata. [SEC] The preview is drawn from a
 * decoded bitmap (or a `blob:` URL in old browsers, revoked on close); no
 * inline `<style>`: styles come from the CSS Module (`style-src 'self'`).
 */
import { type KeyboardEvent, type PointerEvent, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { Button } from "../../../shared/ui/Button";
import { Dialog } from "../../../shared/ui/Dialog";
import { IconButton } from "../../../shared/ui/IconButton";
import { ImageDecodeError } from "../../gallery/lib/resizeCore";
import { cropImageToSquare, decodeForPreview } from "../../gallery/lib/resizeImage";
import {
  CROP_MAX_ZOOM,
  CROP_MIN_ZOOM,
  CROP_PAN_STEP,
  CROP_ZOOM_STEP,
  type CropView,
  cropSpecFor,
  type ImageDims,
  INITIAL_CROP_VIEW,
  panView,
  pinchGeometry,
  rotateView,
  viewScale,
  zoomView
} from "./cropMath";
import styles from "./ImageCropper.module.css";

/** Longest edge of the on-screen preview (px). */
const PREVIEW_MAX_EDGE = 2048;
/** Spoken/visible copy. */
export const CROPPER_TITLE = "Ajustar foto";
export const CROPPER_DECODE_ERROR = "No pudimos leer esta foto. Prueba con otra o guárdala de nuevo como JPG.";
const CROPPER_SAVE_ERROR = "No pudimos preparar la foto. Inténtalo otra vez.";

/** Props for {@link ImageCropper}. */
export interface ImageCropperProps {
  /** The picked image. */
  file: File;
  /** Dialog title; defaults to "Ajustar foto". */
  title?: string;
  /** Closed without saving. */
  onCancel: () => void;
  /** The square JPEG (1024×1024) to upload. */
  onCropped: (file: File) => void;
}

/** A decoded preview and how to free it. */
interface PreviewSource {
  image: CanvasImageSource;
  dims: ImageDims;
  release: () => void;
}

async function loadPreview(file: File): Promise<PreviewSource> {
  try {
    const bitmap = await decodeForPreview(file, PREVIEW_MAX_EDGE);
    return { image: bitmap, dims: { width: bitmap.width, height: bitmap.height }, release: () => bitmap.close() };
  } catch (error) {
    if (typeof createImageBitmap === "function" && error instanceof ImageDecodeError) throw error;
  }
  // Very old WebViews without createImageBitmap: an <img> from a blob: URL (EXIF orientation applied by the browser).
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.decoding = "async";
    image.src = url;
    await image.decode();
    return { image, dims: { width: image.naturalWidth, height: image.naturalHeight }, release: () => URL.revokeObjectURL(url) };
  } catch {
    URL.revokeObjectURL(url);
    throw new ImageDecodeError();
  }
}

/** Paint the image under the view, then the circular mask. */
function paint(canvas: HTMLCanvasElement, source: PreviewSource, view: CropView): void {
  const context = canvas.getContext("2d");
  if (context === null) return;
  const side = canvas.width;
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.fillStyle = "#16201d";
  context.fillRect(0, 0, side, side);
  const scale = viewScale(source.dims, view) * side;
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.translate(side / 2 + view.offsetX * side, side / 2 + view.offsetY * side);
  context.rotate((view.rotation * Math.PI) / 180);
  context.scale(scale, scale);
  context.drawImage(source.image, -source.dims.width / 2, -source.dims.height / 2, source.dims.width, source.dims.height);
  context.setTransform(1, 0, 0, 1, 0, 0);
  // Dim everything outside the circle; the circle is what members will see.
  context.beginPath();
  context.rect(0, 0, side, side);
  context.arc(side / 2, side / 2, side / 2, 0, Math.PI * 2);
  context.fillStyle = "rgba(10, 16, 14, 0.6)";
  context.fill("evenodd");
  context.beginPath();
  context.arc(side / 2, side / 2, side / 2 - 1, 0, Math.PI * 2);
  context.lineWidth = Math.max(1, Math.round(side / 160));
  context.strokeStyle = "rgba(255, 255, 255, 0.9)";
  context.stroke();
}

/**
 * The cropper dialog. Mount it only while a file is being framed (lazy
 * chunk); it frees the decoded preview on unmount.
 */
export function ImageCropper({ file, title = CROPPER_TITLE, onCancel, onCropped }: ImageCropperProps): ReactNode {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [source, setSource] = useState<PreviewSource | null>(null);
  const [view, setView] = useState<CropView>(INITIAL_CROP_VIEW);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [canvasSide, setCanvasSide] = useState(0);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const viewRef = useRef(view);
  viewRef.current = view;

  // Decode the preview; free it when the file changes or the dialog closes.
  useEffect(() => {
    let cancelled = false;
    let loaded: PreviewSource | null = null;
    setSource(null);
    setError(null);
    setView(INITIAL_CROP_VIEW);
    loadPreview(file).then(
      (preview) => {
        if (cancelled) {
          preview.release();
          return;
        }
        loaded = preview;
        setSource(preview);
      },
      () => {
        if (!cancelled) setError(CROPPER_DECODE_ERROR);
      }
    );
    return () => {
      cancelled = true;
      loaded?.release();
    };
  }, [file]);

  // Keep the canvas backing store at device pixels.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return undefined;
    const measure = (): void => {
      const side = Math.max(1, Math.round(canvas.clientWidth * (window.devicePixelRatio || 1)));
      if (canvas.width !== side) {
        canvas.width = side;
        canvas.height = side;
      }
      setCanvasSide(side);
    };
    measure();
    if (typeof ResizeObserver !== "function") return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null || source === null || canvasSide === 0) return undefined;
    const frame = requestAnimationFrame(() => paint(canvas, source, view));
    return () => cancelAnimationFrame(frame);
  }, [source, view, canvasSide]);

  const update = useCallback(
    (next: (dims: ImageDims, current: CropView) => CropView): void => {
      if (source === null) return;
      setView((current) => next(source.dims, current));
    },
    [source]
  );

  // Wheel / trackpad zoom around the cursor (non-passive so the page doesn't scroll).
  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return undefined;
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const anchor = { x: (event.clientX - rect.left) / rect.width - 0.5, y: (event.clientY - rect.top) / rect.height - 0.5 };
      update((dims, current) => zoomView(dims, current, current.zoom * Math.exp(-event.deltaY * 0.0015), anchor));
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, [update]);

  const toViewport = (event: PointerEvent<HTMLDivElement>): { x: number; y: number } => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: (event.clientX - rect.left) / rect.width - 0.5, y: (event.clientY - rect.top) / rect.height - 0.5 };
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    if (source === null) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    pointers.current.set(event.pointerId, toViewport(event));
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    const previous = pointers.current.get(event.pointerId);
    if (previous === undefined) return;
    const point = toViewport(event);
    const others = [...pointers.current].filter(([id]) => id !== event.pointerId).map(([, position]) => position);
    const other = others[0];
    if (other === undefined) {
      update((dims, current) => panView(dims, current, point.x - previous.x, point.y - previous.y));
    } else {
      const before = pinchGeometry(previous, other);
      const after = pinchGeometry(point, other);
      if (before.distance > 0) {
        update((dims, current) => {
          const zoomed = zoomView(dims, current, current.zoom * (after.distance / before.distance), before.mid);
          return panView(dims, zoomed, after.mid.x - before.mid.x, after.mid.y - before.mid.y);
        });
      }
    }
    pointers.current.set(event.pointerId, point);
  };

  const onPointerEnd = (event: PointerEvent<HTMLDivElement>): void => {
    pointers.current.delete(event.pointerId);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const step = event.shiftKey ? CROP_PAN_STEP * 4 : CROP_PAN_STEP;
    const moves: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step]
    };
    const move = moves[event.key];
    if (move !== undefined) {
      update((dims, current) => panView(dims, current, move[0], move[1]));
    } else if (event.key === "+" || event.key === "=") {
      update((dims, current) => zoomView(dims, current, current.zoom + CROP_ZOOM_STEP));
    } else if (event.key === "-" || event.key === "_") {
      update((dims, current) => zoomView(dims, current, current.zoom - CROP_ZOOM_STEP));
    } else if (event.key === "r" || event.key === "R") {
      update(rotateView);
    } else {
      return;
    }
    event.preventDefault();
  };

  const onSave = (): void => {
    if (source === null || saving) return;
    setSaving(true);
    setError(null);
    cropImageToSquare(file, cropSpecFor(source.dims, viewRef.current)).then(
      (cropped) => {
        setSaving(false);
        onCropped(cropped);
      },
      (cause: unknown) => {
        setSaving(false);
        setError(cause instanceof ImageDecodeError ? CROPPER_DECODE_ERROR : CROPPER_SAVE_ERROR);
      }
    );
  };

  const ready = source !== null;
  const zoomPercent = Math.round(view.zoom * 100);

  return (
    <Dialog
      open
      onClose={onCancel}
      title={title}
      description="Arrastra para mover la foto y pellizca o usa el control para acercarla. Lo que quede dentro del círculo es lo que verá la familia."
      closeOnBackdrop={false}
      className={styles.dialog}
      footer={
        <>
          <Button variant="secondary" fullWidth onClick={onCancel} disabled={saving}>
            Cancelar
          </Button>
          <Button fullWidth loading={saving} disabled={!ready} onClick={onSave}>
            Guardar
          </Button>
        </>
      }
    >
      {/* The focusable stage takes drag, pinch and keys; the canvas inside only paints. */}
      <div
        className={styles.stage}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: a 2D pan/zoom widget (role="application") must take focus for keyboard framing (WCAG 2.1.1).
        tabIndex={0}
        role="application"
        aria-roledescription="recorte de foto"
        aria-label="Foto a recortar. Flechas para mover, más y menos para acercar o alejar, R para girar."
        aria-busy={!ready}
        data-testid="image-cropper-canvas"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
        onKeyDown={onKeyDown}
      >
        <canvas ref={canvasRef} className={styles.canvas} />
        {!ready && error === null ? <p className={styles.loading}>Cargando foto…</p> : null}
      </div>
      <div className={styles.controls}>
        <IconButton
          label="Alejar"
          icon="−"
          disabled={!ready || view.zoom <= CROP_MIN_ZOOM}
          onClick={() => update((dims, current) => zoomView(dims, current, current.zoom - CROP_ZOOM_STEP))}
        />
        <input
          type="range"
          className={styles.slider}
          min={CROP_MIN_ZOOM}
          max={CROP_MAX_ZOOM}
          step={0.01}
          value={view.zoom}
          disabled={!ready}
          aria-label="Zoom"
          aria-valuetext={`${zoomPercent} %`}
          onChange={(event) => {
            const zoom = Number(event.currentTarget.value);
            update((dims, current) => zoomView(dims, current, zoom));
          }}
        />
        <IconButton
          label="Acercar"
          icon="+"
          disabled={!ready || view.zoom >= CROP_MAX_ZOOM}
          onClick={() => update((dims, current) => zoomView(dims, current, current.zoom + CROP_ZOOM_STEP))}
        />
        <Button variant="secondary" size="sm" icon="↻" disabled={!ready} onClick={() => update(rotateView)} className={styles.rotate}>
          Girar
        </Button>
      </div>
      {error !== null ? (
        <p className={styles.error} role="alert">
          <span aria-hidden="true">⚠️ </span>
          {error}
        </p>
      ) : null}
    </Dialog>
  );
}
