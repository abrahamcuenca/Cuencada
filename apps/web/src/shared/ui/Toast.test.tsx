import { act, fireEvent, render, screen } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_VISIBLE_TOASTS, MIN_ACTION_TOAST_MS, type ToastApi, type ToastOptions, ToastProvider, evictForNewToast, useToast } from "./Toast";

function Shows({ options }: { options: ToastOptions }): React.ReactNode {
  const toast = useToast();
  useEffect(() => {
    toast.show(options);
  }, [toast, options]);
  return null;
}

function renderToast(options: ToastOptions): void {
  render(
    <ToastProvider>
      <Shows options={options} />
    </ToastProvider>
  );
}

/** Renders a provider and hands back its API for imperative calls. */
function renderApi(): ToastApi {
  let api: ToastApi | null = null;
  function Capture(): React.ReactNode {
    api = useToast();
    return null;
  }
  render(
    <ToastProvider>
      <Capture />
    </ToastProvider>
  );
  if (api === null) throw new Error("toast API missing");
  return api;
}

const undo = { label: "Deshacer", onClick: () => {} };

describe("evictForNewToast", () => {
  it("keeps everything while there is room for the new toast", () => {
    const list = [{ id: "a" }, { id: "b" }];
    expect(evictForNewToast(list)).toEqual({ kept: list, evicted: [] });
    expect(evictForNewToast([])).toEqual({ kept: [], evicted: [] });
  });

  it("evicts the oldest toast without an action, never an action toast", () => {
    const list = [{ id: "a", action: undo }, { id: "b" }, { id: "c" }];
    const { kept, evicted } = evictForNewToast(list);
    expect(evicted.map((t) => t.id)).toEqual(["b"]);
    expect(kept.map((t) => t.id)).toEqual(["a", "c"]);
  });

  it("lets the stack grow when only action toasts remain", () => {
    const list = Array.from({ length: MAX_VISIBLE_TOASTS }, (_, i) => ({ id: String(i), action: undo }));
    expect(evictForNewToast(list)).toEqual({ kept: list, evicted: [] });
  });
});

describe("ToastProvider", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("auto-dismisses a plain toast after 5 seconds", () => {
    renderToast({ message: "Cambios guardados." });
    expect(screen.getByText("Cambios guardados.")).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(screen.queryByText("Cambios guardados.")).not.toBeInTheDocument();
  });

  it("keeps a toast with an action until it is dismissed (WCAG 2.2.1)", () => {
    renderToast({ message: "Foto eliminada.", action: { label: "Deshacer", onClick: () => {} } });
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(screen.getByRole("button", { name: "Deshacer" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cerrar aviso" }));
    expect(screen.queryByText("Foto eliminada.")).not.toBeInTheDocument();
  });

  it("raises a short explicit duration on an action toast to the minimum", () => {
    renderToast({ message: "Foto eliminada.", duration: 2_000, action: { label: "Deshacer", onClick: () => {} } });
    act(() => {
      vi.advanceTimersByTime(MIN_ACTION_TOAST_MS - 1);
    });
    expect(screen.getByText("Foto eliminada.")).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.queryByText("Foto eliminada.")).not.toBeInTheDocument();
  });

  it("pauses the timer while hovered or focused and resumes afterwards", () => {
    renderToast({ message: "Cambios guardados." });
    const toast = screen.getByText("Cambios guardados.").parentElement;
    if (!toast) throw new Error("toast missing");

    act(() => {
      vi.advanceTimersByTime(3_000);
    });
    fireEvent.pointerEnter(toast);
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(screen.getByText("Cambios guardados.")).toBeInTheDocument();

    fireEvent.pointerLeave(toast);
    fireEvent.focus(screen.getByRole("button", { name: "Cerrar aviso" }));
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(screen.getByText("Cambios guardados.")).toBeInTheDocument();

    fireEvent.blur(screen.getByRole("button", { name: "Cerrar aviso" }));
    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    expect(screen.queryByText("Cambios guardados.")).not.toBeInTheDocument();
  });

  it("announces errors in the assertive region", () => {
    renderToast({ message: "No pudimos subir la foto.", tone: "danger" });
    expect(screen.getByRole("alert")).toHaveTextContent("No pudimos subir la foto.");
  });

  it("never drops an action toast when the stack is full", () => {
    const api = renderApi();
    act(() => {
      api.show({ message: "Foto eliminada.", action: undo });
      api.show({ message: "Uno." });
      api.show({ message: "Dos." });
      api.show({ message: "Tres." });
    });
    expect(screen.getByText("Foto eliminada.")).toBeInTheDocument();
    expect(screen.queryByText("Uno.")).not.toBeInTheDocument();
    expect(screen.getByText("Dos.")).toBeInTheDocument();
    expect(screen.getByText("Tres.")).toBeInTheDocument();
  });

  it("keeps every action toast even beyond the visible limit", () => {
    const api = renderApi();
    act(() => {
      for (let i = 1; i <= MAX_VISIBLE_TOASTS + 1; i += 1) api.show({ message: `Acción ${i}.`, action: undo });
    });
    expect(screen.getAllByRole("button", { name: "Deshacer" })).toHaveLength(MAX_VISIBLE_TOASTS + 1);
  });

  it("clears the timer of an evicted toast", () => {
    const api = renderApi();
    act(() => {
      api.show({ message: "Uno." });
      api.show({ message: "Dos." });
      api.show({ message: "Tres." });
    });
    expect(vi.getTimerCount()).toBe(3);
    act(() => {
      api.show({ message: "Cuatro." });
    });
    expect(screen.queryByText("Uno.")).not.toBeInTheDocument();
    expect(vi.getTimerCount()).toBe(3);
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(vi.getTimerCount()).toBe(0);
    expect(screen.queryByText("Cuatro.")).not.toBeInTheDocument();
  });
});
