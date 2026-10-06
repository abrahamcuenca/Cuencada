import { act, fireEvent, render, screen } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MIN_ACTION_TOAST_MS, type ToastOptions, ToastProvider, useToast } from "./Toast";

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
});
