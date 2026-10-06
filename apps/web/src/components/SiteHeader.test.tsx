import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AuthProvider } from "../app/auth";
import { SiteHeader } from "./SiteHeader";

describe("SiteHeader", () => {
  it("renders the main navigation without the admin link for anonymous visitors", async () => {
    render(
      <MemoryRouter>
        <AuthProvider>
          <SiteHeader />
        </AuthProvider>
      </MemoryRouter>
    );

    const nav = await screen.findByRole("navigation", { name: "Navegación principal" });
    expect(nav).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Programa" })).toHaveAttribute("href", "/cuencada/2026");
    expect(screen.queryByRole("link", { name: "Admin" })).not.toBeInTheDocument();
  });
});
