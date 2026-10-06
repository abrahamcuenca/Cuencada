import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Badge, formatCount } from "./Badge";

describe("formatCount", () => {
  it("shows counts up to the cap as-is and caps above it", () => {
    expect(formatCount(0)).toBe("0");
    expect(formatCount(99)).toBe("99");
    expect(formatCount(100)).toBe("99+");
    expect(formatCount(999, 999)).toBe("999");
    expect(formatCount(1000, 999)).toBe("999+");
  });

  it("falls back to 99 for a cap that is not a positive integer", () => {
    expect(formatCount(150, 0)).toBe("99+");
    expect(formatCount(150, -5)).toBe("99+");
    expect(formatCount(150, 2.5)).toBe("99+");
  });
});

describe("Badge", () => {
  it("caps a count badge at 99+ by default", () => {
    render(<Badge shape="count">{120}</Badge>);
    expect(screen.getByText("99+")).toBeInTheDocument();
  });

  it("caps a count badge at max+ when max is given", () => {
    render(
      <Badge shape="count" max={999}>
        {1200}
      </Badge>
    );
    expect(screen.getByText("999+")).toBeInTheDocument();
  });

  it("shows the exact count under the cap and keeps the screen-reader label", () => {
    render(
      <Badge shape="count" max={999} srLabel="450 mensajes sin leer">
        {450}
      </Badge>
    );
    expect(screen.getByText("450")).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByText("450 mensajes sin leer")).toBeInTheDocument();
  });
});
