import { type KeyboardEvent, type PointerEvent, type ReactNode, useCallback, useId, useRef } from "react";
import { IconButton } from "./IconButton";
import styles from "./Lightbox.module.css";
import { cx } from "./cx";
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

/**
 * Full-screen, thumb-friendly media viewer on native `<dialog>`.
 * Swipe left/right (pointer events: touch, pen, mouse), ←/→ keys, Esc to close.
 * Does not wrap around; the counter ("3 de 12") is announced politely.
 */
export function Lightbox({ items, index, onIndexChange, onClose, actions, label = "Visor de fotos" }: LightboxProps): React.ReactNode {
  const ref = useRef<HTMLDialogElement>(null);
  const counterId = useId();
  const open = index !== null && items.length > 0;
  const bindings = useModalDialog(ref, open, onClose, false);
  const pointer = useRef<{ id: number; x: number; y: number } | null>(null);

  const current = index === null ? undefined : items[index];
  const hasPrev = index !== null && index > 0;
  const hasNext = index !== null && index < items.length - 1;

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
    const inVideo = event.target instanceof HTMLVideoElement;
    if (event.key === "ArrowRight" && !inVideo) {
      event.preventDefault();
      go(1);
      return;
    }
    if (event.key === "ArrowLeft" && !inVideo) {
      event.preventDefault();
      go(-1);
      return;
    }
    bindings.onKeyDown(event);
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    if (!event.isPrimary) return;
    pointer.current = { id: event.pointerId, x: event.clientX, y: event.clientY };
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
              <IconButton label="Cerrar visor" icon="✕" variant="inverse" onClick={onClose} data-autofocus="" />
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
            <IconButton label="Anterior" icon="‹" size="lg" variant="inverse" onClick={() => go(-1)} disabled={!hasPrev} className={styles.nav} />
            <div className={styles.caption}>{current.caption}</div>
            <IconButton label="Siguiente" icon="›" size="lg" variant="inverse" onClick={() => go(1)} disabled={!hasNext} className={cx(styles.nav)} />
          </div>
        </div>
      ) : null}
    </dialog>
  );
}
