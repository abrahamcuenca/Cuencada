// @vitest-environment jsdom
import "./testing";
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
});
