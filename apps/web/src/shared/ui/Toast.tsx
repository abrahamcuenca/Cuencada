import { type ReactNode, createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { IconButton } from "./IconButton";
import styles from "./Toast.module.css";
import { cx } from "./cx";

/** Visual + semantic tone of a toast. `danger` is announced assertively. */
export type ToastTone = "info" | "success" | "danger";

/** Options for {@link ToastApi.show}. */
export interface ToastOptions {
  message: ReactNode;
  tone?: ToastTone;
  /** Auto-dismiss after ms. Defaults to 5000 (8000 for `danger`). `0` keeps it until dismissed. */
  duration?: number;
  /** Optional single action, e.g. { label: "Deshacer", onClick }. */
  action?: { label: string; onClick: () => void };
}

/** Imperative API returned by {@link useToast}. */
export interface ToastApi {
  /** Shows a toast and returns its id. */
  show: (options: ToastOptions) => string;
  dismiss: (id: string) => void;
}

interface ToastRecord extends ToastOptions {
  id: string;
  tone: ToastTone;
}

const ToastContext = createContext<ToastApi | null>(null);

const ICONS: Record<ToastTone, string> = { info: "💬", success: "✅", danger: "⚠️" };

/** Props for {@link ToastProvider}. */
export interface ToastProviderProps {
  children: ReactNode;
}

/**
 * Hosts the toast stack and its live regions (polite for info/success, assertive
 * for errors). Toasts sit above the bottom nav and the home indicator.
 */
export function ToastProvider({ children }: ToastProviderProps): React.ReactNode {
  const [toasts, setToasts] = useState<ToastRecord[]>([]);
  const counter = useRef(0);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: string): void => {
    const timer = timers.current.get(id);
    if (timer) clearTimeout(timer);
    timers.current.delete(id);
    setToasts((list) => list.filter((t) => t.id !== id));
  }, []);

  const show = useCallback(
    (options: ToastOptions): string => {
      counter.current += 1;
      const id = `toast-${counter.current}`;
      const tone = options.tone ?? "info";
      const duration = options.duration ?? (tone === "danger" ? 8000 : 5000);
      setToasts((list) => [...list.slice(-2), { ...options, id, tone }]);
      if (duration > 0) timers.current.set(id, setTimeout(() => dismiss(id), duration));
      return id;
    },
    [dismiss]
  );

  useEffect(() => {
    const map = timers.current;
    return () => {
      for (const timer of map.values()) clearTimeout(timer);
      map.clear();
    };
  }, []);

  const api = useMemo<ToastApi>(() => ({ show, dismiss }), [show, dismiss]);

  const render = (list: ToastRecord[]): ReactNode =>
    list.map((toast) => (
      <div key={toast.id} className={cx(styles.toast, styles[toast.tone])}>
        <span aria-hidden="true" className={styles.icon}>
          {ICONS[toast.tone]}
        </span>
        <div className={styles.message}>{toast.message}</div>
        {toast.action ? (
          <button
            type="button"
            className={styles.action}
            onClick={() => {
              toast.action?.onClick();
              dismiss(toast.id);
            }}
          >
            {toast.action.label}
          </button>
        ) : null}
        <IconButton label="Cerrar aviso" icon="✕" variant="inverse" onClick={() => dismiss(toast.id)} />
      </div>
    ));

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className={styles.viewport}>
        {/* biome-ignore lint/a11y/useSemanticElements: <output> may only hold phrasing content; toasts contain block elements. */}
        <div role="status" aria-live="polite" className={styles.region}>
          {render(toasts.filter((t) => t.tone !== "danger"))}
        </div>
        <div role="alert" aria-live="assertive" className={styles.region}>
          {render(toasts.filter((t) => t.tone === "danger"))}
        </div>
      </div>
    </ToastContext.Provider>
  );
}

/** Access the toast API. Must be used under {@link ToastProvider}. */
export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast debe usarse dentro de <ToastProvider>.");
  return ctx;
}
