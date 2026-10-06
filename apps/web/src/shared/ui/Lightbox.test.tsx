import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { Lightbox, type LightboxItem } from "./Lightbox";

const ITEMS: LightboxItem[] = [
  { id: "a", type: "image", src: "/a.webp", alt: "Cenote Santa Bárbara" },
  { id: "b", type: "image", src: "/b.webp", alt: "Izamal amarillo" },
  { id: "c", type: "video", src: "/c.mp4", alt: "Mariachi en el Cuencada Fest" }
];

function Harness({ start = 0, onClose = () => {} }: { start?: number; onClose?: () => void }): React.ReactNode {
  const [index, setIndex] = useState<number | null>(start);
  return (
    <Lightbox
      items={ITEMS}
      index={index}
      onIndexChange={setIndex}
      onClose={() => {
        onClose();
        setIndex(null);
      }}
    />
  );
}

describe("Lightbox", () => {
  it("shows the current item and a position counter", () => {
    render(<Harness />);
    expect(screen.getByRole("img", { name: "Cenote Santa Bárbara" })).toBeInTheDocument();
    expect(screen.getByText("1 de 3")).toBeInTheDocument();
  });

  it("moves with the arrow keys and stops at both ends", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("img", { name: "Izamal amarillo" })).toBeInTheDocument();
    expect(screen.getByText("2 de 3")).toBeInTheDocument();

    await user.keyboard("{ArrowRight}");
    expect(screen.getByLabelText("Mariachi en el Cuencada Fest").tagName).toBe("VIDEO");

    await user.keyboard("{ArrowRight}");
    expect(screen.getByText("3 de 3")).toBeInTheDocument();

    await user.keyboard("{ArrowLeft}{ArrowLeft}{ArrowLeft}");
    expect(screen.getByText("1 de 3")).toBeInTheDocument();
  });

  it("closes on Escape", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("1 de 3")).not.toBeInTheDocument();
  });

  it("disables the previous button on the first item and the next button on the last", () => {
    const { unmount } = render(<Harness start={0} />);
    expect(screen.getByRole("button", { name: "Anterior" })).toBeDisabled();
    unmount();
    render(<Harness start={2} />);
    expect(screen.getByRole("button", { name: "Siguiente" })).toBeDisabled();
  });

  it("navigates on a horizontal swipe but ignores short or vertical drags", () => {
    render(<Harness start={1} />);
    const stage = screen.getByRole("img", { name: "Izamal amarillo" }).parentElement;
    if (!stage) throw new Error("stage missing");

    // Vertical drag: ignored.
    fireEvent.pointerDown(stage, { pointerId: 1, isPrimary: true, clientX: 200, clientY: 100 });
    fireEvent.pointerUp(stage, { pointerId: 1, isPrimary: true, clientX: 180, clientY: 400 });
    expect(screen.getByText("2 de 3")).toBeInTheDocument();

    // Swipe right → previous.
    fireEvent.pointerDown(stage, { pointerId: 2, isPrimary: true, clientX: 50, clientY: 100 });
    fireEvent.pointerUp(stage, { pointerId: 2, isPrimary: true, clientX: 250, clientY: 110 });
    expect(screen.getByText("1 de 3")).toBeInTheDocument();
  });

  it("does not navigate when a horizontal drag starts on the video (seek bar scrubbing)", () => {
    render(<Harness start={2} />);
    const video = screen.getByLabelText("Mariachi en el Cuencada Fest");
    const stage = video.parentElement;
    if (!stage) throw new Error("stage missing");

    fireEvent.pointerDown(video, { pointerId: 3, isPrimary: true, clientX: 40, clientY: 300 });
    fireEvent.pointerUp(stage, { pointerId: 3, isPrimary: true, clientX: 300, clientY: 300 });
    expect(screen.getByText("3 de 3")).toBeInTheDocument();
  });

  it("does not hijack arrow keys pressed on the video", () => {
    render(<Harness start={2} />);
    fireEvent.keyDown(screen.getByLabelText("Mariachi en el Cuencada Fest"), { key: "ArrowLeft" });
    expect(screen.getByText("3 de 3")).toBeInTheDocument();
  });

  it("moves focus to the opposite nav button when the focused one becomes disabled", async () => {
    const user = userEvent.setup();
    render(<Harness start={1} />);
    await user.click(screen.getByRole("button", { name: "Siguiente" }));
    expect(screen.getByText("3 de 3")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Anterior" })).toHaveFocus();

    await user.click(screen.getByRole("button", { name: "Anterior" }));
    await user.click(screen.getByRole("button", { name: "Anterior" }));
    expect(screen.getByText("1 de 3")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Siguiente" })).toHaveFocus();
  });

  it("is an aria-modal dialog", () => {
    render(<Harness />);
    expect(screen.getByRole("dialog", { name: "Visor de fotos" })).toHaveAttribute("aria-modal", "true");
  });

  it("closes when the open item disappears from the list", () => {
    const onClose = vi.fn();
    const { rerender } = render(<Lightbox items={ITEMS} index={2} onIndexChange={() => {}} onClose={onClose} />);
    rerender(<Lightbox items={ITEMS.slice(0, 2)} index={2} onIndexChange={() => {}} onClose={onClose} />);
    expect(onClose).toHaveBeenCalled();
  });
});
