import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AvatarCircle, getInitials } from "./AvatarCircle";

describe("getInitials", () => {
  it("skips Spanish particles", () => {
    expect(getInitials("María de la Luz Vega")).toBe("MV");
  });

  it("falls back to ? for an empty name", () => {
    expect(getInitials("  ")).toBe("?");
  });
});

describe("AvatarCircle", () => {
  it("falls back to initials when the image fails and retries when src changes", () => {
    const { container, rerender } = render(<AvatarCircle name="Rosa Ibarra" src="/rota.jpg" />);
    const img = container.querySelector("img");
    if (!img) throw new Error("img missing");
    fireEvent.error(img);
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByRole("img", { name: "Rosa Ibarra" })).toHaveTextContent("RI");

    rerender(<AvatarCircle name="Rosa Ibarra" src="/nueva.jpg" />);
    expect(container.querySelector("img")).toHaveAttribute("src", "/nueva.jpg");
  });
});
