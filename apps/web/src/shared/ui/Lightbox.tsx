import { type KeyboardEvent, type PointerEvent, type ReactNode, useCallback, useEffect, useId, useRef } from "react";
import { IconButton } from "./IconButton";
import styles from "./Lightbox.module.css";
import { useModalDialog } from "./useModalDialog";

/** One photo or video in a {@link Lightbox}. */
export interface LightboxItem {
  id: string;
  type: "image" | "video";
  /** Display-size URL (1600px WebP for photos). */
  src: string;
  /** Required for images; describe the moment ("Abuela Rosa en Izamal"). */
  alt: string;
  /** Poster frame for videos. */
  poster?: string;
  /** Caption shown under the media (uploader, date). */
  caption?: ReactNode;
  width?: number;
  height?: number;
}

/** Props for {@link Lightbox}. */
export interface LightboxProps {
  items: readonly LightboxItem[];
  /** Index of the open item, or `null` when closed. */
  index: number | null;
  onIndexChange: (index: number) => void;
  onClose: () => void;
  /** Extra actions in the top bar (download, report). */
  actions?: ReactNode;
  /** Accessible name of the viewer. Defaults to "Visor de fotos". */
  label?: string;
}

/** Horizontal distance (px) a pointer must travel to count as a swipe. */
export const SWIPE_THRESHOLD = 50;

/** True when a pointer/key event originates on (or inside) a video/audio element and its native controls. */
function isFromMedia(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest("video, audio") !== null;
}

/**
 * Full-screen, thumb-friendly media viewer on native `<dialog>`.
 * Swipe left/right (pointer events with capture: touch, pen, mouse), ←/→ keys, Esc to close.
 * Gestures that start on a video (seek bar, volume) never navigate.
 * Does not wrap around; the counter ("3 de 12") is announced politely, and focus
 * moves off a nav button that becomes disabled at either end.
 */
export function Lightbox({ items, index, onIndexChange, onClose, actions, label = "Visor de fotos" }: LightboxProps): React.ReactNode {
  const ref = useRef<HTMLDialogElement>(null);
  const prevRef = useRef<HTMLButtonElement>(null);
  const nextRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const counterId = useId();
  const current = index === null ? undefined : items[index];
  const open = index !== null && current !== undefined;
  const bindings = useModalDialog(ref, open, onClose, false);
  const pointer = useRef<{ id: number; x: number; y: number } | null>(null);

  const hasPrev = index !== null && index > 0;
  const hasNext = index !== null && index < items.length - 1;

  // The list shrank under us (item deleted/hidden): close instead of rendering an empty modal.
  useEffect(() => {
    if (index !== null && current === undefined) onClose();
  }, [index, current, onClose]);

  // Keep keyboard focus inside the viewer when a nav button turns disabled at an end.
  useEffect(() => {
    const active = document.activeElement;
    if (active === nextRef.current && !hasNext) (hasPrev ? prevRef.current : closeRef.current)?.focus();
    else if (active === prevRef.current && !hasPrev) (hasNext ? nextRef.current : closeRef.current)?.focus();
  }, [hasPrev, hasNext]);

  const go = useCallback(
    (delta: -1 | 1): void => {
      if (index === null) return;
      const next = index + delta;
      if (next >= 0 && next < items.length) onIndexChange(next);
    },
    [index, items.length, onIndexChange]
  );

  const onKeyDown = (event: KeyboardEvent<HTMLDialogElement>): void => {
    // Let native video controls keep their arrow-key seeking.
    const inMedia = isFromMedia(event.target);
    if (event.key === "ArrowRight" && !inMedia) {
      event.preventDefault();
      go(1);
      return;
    }
    if (event.key === "ArrowLeft" && !inMedia) {
      event.preventDefault();
      go(-1);
      return;
    }
    bindings.onKeyDown(event);
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    // Scrubbing the seek bar or volume must not be read as a swipe.
    if (!event.isPrimary || isFromMedia(event.target)) {
      pointer.current = null;
      return;
    }
    pointer.current = { id: event.pointerId, x: event.clientX, y: event.clientY };
    // Capture so a drag released outside the stage still ends here.
    if (typeof event.currentTarget.setPointerCapture === "function") {
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // Synthetic/inactive pointers cannot be captured; the gesture still works.
      }
    }
  };

  const onPointerUp = (event: PointerEvent<HTMLDivElement>): void => {
    const start = pointer.current;
    pointer.current = null;
    if (!start || start.id !== event.pointerId) return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    if (Math.abs(dx) < SWIPE_THRESHOLD || Math.abs(dx) < Math.abs(dy)) return;
    go(dx < 0 ? 1 : -1);
  };

  return (
    <dialog
      ref={ref}
      aria-label={label}
      aria-modal="true"
      aria-describedby={open ? counterId : undefined}
      className={styles.lightbox}
      tabIndex={-1}
      onCancel={bindings.onCancel}
      onKeyDown={onKeyDown}
    >
      {open && current && index !== null ? (
        <div className={styles.frame}>
          <div className={styles.topBar}>
            <p id={counterId} className={styles.counter} aria-live="polite">
              {index + 1} de {items.length}
            </p>
            <div className={styles.actions}>
              {actions}
              <IconButton ref={closeRef} label="Cerrar visor" icon="✕" variant="inverse" onClick={onClose} data-autofocus="" />
            </div>
          </div>

          <div
            className={styles.stage}
            onPointerDown={onPointerDown}
            onPointerUp={onPointerUp}
            onPointerCancel={() => {
              pointer.current = null;
            }}
          >
            {current.type === "image" ? (
              <img
                key={current.id}
                src={current.src}
                alt={current.alt}
                width={current.width}
                height={current.height}
                className={styles.media}
                draggable={false}
                decoding="async"
              />
            ) : (
              // biome-ignore lint/a11y/useMediaCaption: family home videos have no caption tracks; the caption text describes them.
              <video
                key={current.id}
                src={current.src}
                poster={current.poster}
                aria-label={current.alt}
                className={styles.media}
                controls
                playsInline
                preload="metadata"
              />
            )}
          </div>

          <div className={styles.bottomBar}>
            <IconButton ref={prevRef} label="Anterior" icon="‹" size="lg" variant="inverse" onClick={() => go(-1)} disabled={!hasPrev} className={styles.nav} />
            <div className={styles.caption}>{current.caption}</div>
            <IconButton ref={nextRef} label="Siguiente" icon="›" size="lg" variant="inverse" onClick={() => go(1)} disabled={!hasNext} className={styles.nav} />
          </div>
        </div>
      ) : null}
    </dialog>
  );
}
