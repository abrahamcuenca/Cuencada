import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Button } from "./Button";

describe("Button", () => {
  it("renders a type=button by default", () => {
    render(<Button>Guardar</Button>);
    expect(screen.getByRole("button", { name: "Guardar" })).toHaveAttribute("type", "button");
  });

  it("opens external links in a new tab with noopener noreferrer", () => {
    render(
      <Button href="https://chat.whatsapp.com/x" external>
        WhatsApp
      </Button>
    );
    const link = screen.getByRole("link", { name: "WhatsApp" });
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("adds noopener noreferrer to a raw target=_blank and keeps other rel tokens", () => {
    render(
      <Button href="https://maps.google.com" target="_blank" rel="nofollow">
        Mapa
      </Button>
    );
    const rel = screen.getByRole("link", { name: "Mapa" }).getAttribute("rel")?.split(" ") ?? [];
    expect(rel).toEqual(expect.arrayContaining(["nofollow", "noopener", "noreferrer"]));
  });

  it("does not add rel to same-tab anchors", () => {
    render(<Button href="#programa">Programa</Button>);
    expect(screen.getByRole("link", { name: "Programa" })).not.toHaveAttribute("rel");
  });

  it("disables and marks busy while loading", () => {
    render(<Button loading>Guardando</Button>);
    const button = screen.getByRole("button", { name: "Guardando" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
  });
});
