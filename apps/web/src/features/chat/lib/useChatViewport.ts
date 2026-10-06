import { type RefObject, useLayoutEffect } from "react";

/** The visual viewport is this much shorter than the window → treat it as an on-screen keyboard. */
const KEYBOARD_THRESHOLD_PX = 120;
/** Never shrink the chat below this, even on tiny landscape phones. */
const MIN_HEIGHT_PX = 200;

/** Geometry inputs of {@link chatPaneGeometry}. */
export interface ViewportInput {
  /** Top of the marker (below the TopNav/banners), in layout-viewport px. */
  markerTop: number;
  /** `visualViewport.offsetTop` (0 without the API). */
  viewportTop: number;
  /** `visualViewport.height` (or `innerHeight`). */
  viewportHeight: number;
  /** `window.innerHeight`. */
  windowHeight: number;
}

/** Where the fixed chat panes go. */
export interface PaneGeometry {
  top: number;
  height: number;
  keyboardOpen: boolean;
}

/**
 * Fits the chat between the app bar and the bottom of the *visual* viewport,
 * which is the top of the on-screen keyboard when it is open (iOS does not
 * resize the layout viewport for the keyboard).
 *
 * @param input - Measurements.
 * @returns The pane's top, height and whether a keyboard is up.
 */
export function chatPaneGeometry({ markerTop, viewportTop, viewportHeight, windowHeight }: ViewportInput): PaneGeometry {
  const top = Math.max(markerTop, viewportTop);
  const height = Math.max(MIN_HEIGHT_PX, Math.round(viewportTop + viewportHeight - top));
  return { top: Math.round(top), height, keyboardOpen: windowHeight - viewportHeight > KEYBOARD_THRESHOLD_PX };
}

/**
 * Keeps `--chat-top` / `--chat-height` / `data-keyboard` on the chat layout in
 * sync with the visual viewport (keyboard, pinch zoom, banners appearing).
 *
 * @param layoutRef - The fixed layout element.
 * @param markerRef - A zero-height element where the panes should start.
 */
export function useChatViewport(layoutRef: RefObject<HTMLElement | null>, markerRef: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    const layout = layoutRef.current;
    const marker = markerRef.current;
    if (layout === null || marker === null) return undefined;
    const viewport = window.visualViewport;
    let frame = 0;

    const update = (): void => {
      frame = 0;
      const geometry = chatPaneGeometry({
        markerTop: marker.getBoundingClientRect().top,
        viewportTop: viewport?.offsetTop ?? 0,
        viewportHeight: viewport?.height ?? window.innerHeight,
        windowHeight: window.innerHeight
      });
      layout.style.setProperty("--chat-top", `${geometry.top}px`);
      layout.style.setProperty("--chat-height", `${geometry.height}px`);
      layout.dataset.keyboard = geometry.keyboardOpen ? "open" : "closed";
    };
    const schedule = (): void => {
      if (frame === 0) frame = requestAnimationFrame(update);
    };

    update();
    viewport?.addEventListener("resize", schedule);
    viewport?.addEventListener("scroll", schedule);
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, { passive: true });
    // Banners (offline, verify email) above the marker move it.
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    observer?.observe(document.body);

    return () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      viewport?.removeEventListener("resize", schedule);
      viewport?.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule);
      observer?.disconnect();
    };
  }, [layoutRef, markerRef]);
}
