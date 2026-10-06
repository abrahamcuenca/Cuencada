import { type KeyboardEvent, type RefObject, useCallback, useEffect, useRef } from "react";

const FOCUSABLE = [
  "a[href]",
  "area[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "video[controls]",
  "audio[controls]",
  "[tabindex]:not([tabindex='-1'])",
  "[contenteditable='true']"
].join(",");

/** Returns the keyboard-focusable descendants of `root`, in DOM order. */
export function getFocusable(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => !el.hasAttribute("inert") && el.getAttribute("aria-hidden") !== "true");
}

/** Return value of {@link useModalDialog}. */
export interface ModalDialogBindings {
  /** Spread on the `<dialog>` element. */
  onKeyDown: (event: KeyboardEvent<HTMLDialogElement>) => void;
  onCancel: (event: React.SyntheticEvent<HTMLDialogElement>) => void;
  onClick: (event: React.MouseEvent<HTMLDialogElement>) => void;
}

/**
 * Drives a native `<dialog>` as a modal: `showModal()` when `open` turns true
 * (with an `open`-attribute fallback where unsupported, e.g. jsdom), focus on the
 * first `[autofocus]`/focusable element, a Tab focus trap, Esc and backdrop
 * click → `onClose`, page scroll lock, and focus restoration on close.
 */
export function useModalDialog(ref: RefObject<HTMLDialogElement | null>, open: boolean, onClose: () => void, closeOnBackdrop = true): ModalDialogBindings {
  const returnFocus = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog || !open) return;

    // Capture the opener BEFORE showModal() moves focus, and only once per open
    // cycle (StrictMode re-runs effects; the cleanup below resets it first).
    if (returnFocus.current === null) {
      const active = document.activeElement;
      returnFocus.current = active instanceof HTMLElement && active !== document.body && !dialog.contains(active) ? active : null;
    }

    if (!dialog.open) {
      if (typeof dialog.showModal === "function") {
        try {
          dialog.showModal();
        } catch {
          dialog.setAttribute("open", "");
        }
      } else {
        dialog.setAttribute("open", "");
      }
    }
    const initial = dialog.querySelector<HTMLElement>("[autofocus], [data-autofocus]") ?? getFocusable(dialog)[0] ?? dialog;
    initial.focus();

    const root = document.documentElement;
    const previousOverflow = root.style.overflow;
    root.style.overflow = "hidden";
    // Runs when `open` turns false AND when the component unmounts while open,
    // so every exit path closes the dialog and restores focus.
    return () => {
      root.style.overflow = previousOverflow;
      if (dialog.open || dialog.hasAttribute("open")) {
        if (typeof dialog.close === "function") dialog.close();
        dialog.removeAttribute("open");
      }
      const target = returnFocus.current;
      returnFocus.current = null;
      if (target?.isConnected) target.focus();
    };
  }, [open, ref]);

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDialogElement>): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const dialog = ref.current;
      if (!dialog) return;
      const focusable = getFocusable(dialog);
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const active = document.activeElement;
      if (event.shiftKey && (active === first || active === dialog)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    },
    [ref]
  );

  const onCancel = useCallback((event: React.SyntheticEvent<HTMLDialogElement>): void => {
    // Native Esc: keep React state as the source of truth.
    event.preventDefault();
    onCloseRef.current();
  }, []);

  const onClick = useCallback(
    (event: React.MouseEvent<HTMLDialogElement>): void => {
      // The dialog element itself only receives the click when the backdrop is hit
      // (content lives in an inner wrapper that fills the box).
      if (closeOnBackdrop && event.target === event.currentTarget) onCloseRef.current();
    },
    [closeOnBackdrop]
  );

  return { onKeyDown, onCancel, onClick };
}
