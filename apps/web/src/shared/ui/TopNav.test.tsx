import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TopNav } from "./TopNav";
import type { RenderNavLink } from "./nav";

describe("TopNav", () => {
  it("renders the default brand link through renderLink (no full-page reload)", () => {
    const renderLink: RenderNavLink = ({ href, className, children, item }) => (
      <a href={href} className={className} data-router-link={item.key}>
        {children}
      </a>
    );
    render(<TopNav items={[{ key: "programa", label: "Programa", href: "/cuencada/2027" }]} currentPath="/" renderLink={renderLink} />);
    const brand = screen.getByRole("link", { name: "Cuencada" });
    expect(brand).toHaveAttribute("href", "/");
    expect(brand).toHaveAttribute("data-router-link", "brand");
    expect(brand).not.toHaveAttribute("aria-current");
  });
});
