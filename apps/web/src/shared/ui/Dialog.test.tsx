import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { Dialog } from "./Dialog";

function Harness({ onClose = () => {} }: { onClose?: () => void }): React.ReactNode {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Abrir
      </button>
      <Dialog
        open={open}
        onClose={() => {
          onClose();
          setOpen(false);
        }}
        title="Confirmar asistencia"
        description="¿Vas a la Cuencada 2027?"
        footer={
          <>
            <button type="button">No voy</button>
            <button type="button">Sí, voy</button>
          </>
        }
      >
        <input aria-label="Acompañantes" />
      </Dialog>
    </>
  );
}

describe("Dialog", () => {
  it("renders nothing interactive while closed", () => {
    render(<Harness />);
    expect(screen.queryByRole("heading", { name: "Confirmar asistencia" })).not.toBeInTheDocument();
  });

  it("opens with an accessible name and description and focuses the first control", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("button", { name: "Abrir" }));

    const dialog = screen.getByRole("dialog", { name: "Confirmar asistencia" });
    expect(dialog).toHaveAttribute("open");
    expect(dialog).toHaveAccessibleDescription("¿Vas a la Cuencada 2027?");
    expect(screen.getByRole("button", { name: "Cerrar" })).toHaveFocus();
  });

  it("traps focus: Tab from the last control wraps to the first and Shift+Tab wraps back", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("button", { name: "Abrir" }));

    screen.getByRole("button", { name: "Sí, voy" }).focus();
    await user.tab();
    expect(screen.getByRole("button", { name: "Cerrar" })).toHaveFocus();

    await user.tab({ shift: true });
    expect(screen.getByRole("button", { name: "Sí, voy" })).toHaveFocus();
  });

  it("closes on Escape and returns focus to the opener", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    const opener = screen.getByRole("button", { name: "Abrir" });
    await user.click(opener);

    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("heading", { name: "Confirmar asistencia" })).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  it("closes when the close button is pressed", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    await user.click(screen.getByRole("button", { name: "Abrir" }));
    await user.click(screen.getByRole("button", { name: "Cerrar" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("restores focus to the opener when it unmounts while open", async () => {
    const user = userEvent.setup();
    function Unmounting(): React.ReactNode {
      const [shown, setShown] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setShown(true)}>
            Abrir
          </button>
          {shown ? (
            <Dialog open onClose={() => {}} title="Aviso">
              <button type="button" onClick={() => setShown(false)}>
                Quitar
              </button>
            </Dialog>
          ) : null}
        </>
      );
    }
    render(<Unmounting />);
    const opener = screen.getByRole("button", { name: "Abrir" });
    await user.click(opener);
    await user.click(screen.getByRole("button", { name: "Quitar" }));
    expect(screen.queryByRole("heading", { name: "Aviso" })).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
    expect(document.documentElement.style.overflow).toBe("");
  });

  it("captures the real opener under StrictMode when mounted already open", async () => {
    const user = userEvent.setup();
    function InitiallyOpen(): React.ReactNode {
      const [open, setOpen] = useState(true);
      return (
        <Dialog open={open} onClose={() => setOpen(false)} title="Bienvenida">
          <p>Hola</p>
        </Dialog>
      );
    }
    function Page(): React.ReactNode {
      const [mounted, setMounted] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setMounted(true)}>
            Ver aviso
          </button>
          {mounted ? <InitiallyOpen /> : null}
        </>
      );
    }
    render(
      <StrictMode>
        <Page />
      </StrictMode>
    );
    const opener = screen.getByRole("button", { name: "Ver aviso" });
    await user.click(opener);
    expect(screen.getByRole("button", { name: "Cerrar" })).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(opener).toHaveFocus();
  });
});
