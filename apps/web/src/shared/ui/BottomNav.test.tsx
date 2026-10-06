import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { BottomNav } from "./BottomNav";
import { type NavItem, isPathActive } from "./nav";

const ITEMS: NavItem[] = [
  { key: "inicio", label: "Inicio", href: "/", icon: "🏠" },
  { key: "programa", label: "Programa", href: "/cuencada/2027", icon: "📅" },
  { key: "fotos", label: "Fotos", href: "/galeria", icon: "📸" },
  { key: "chat", label: "Chat", href: "/chat", icon: "💬", badge: 3, badgeLabel: "3 mensajes sin leer" },
  { key: "mas", label: "Más", href: "/mas", icon: "☰" }
];

describe("BottomNav", () => {
  it("renders a labelled navigation landmark with every tab", () => {
    render(<BottomNav items={ITEMS} currentPath="/" />);
    const nav = screen.getByRole("navigation", { name: "Navegación principal" });
    expect(nav.querySelectorAll("a")).toHaveLength(5);
  });

  it("marks only the matching tab with aria-current=page", () => {
    render(<BottomNav items={ITEMS} currentPath="/galeria/2026" />);
    expect(screen.getByRole("link", { name: /Fotos/ })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: /Inicio/ })).not.toHaveAttribute("aria-current");
    expect(screen.getByRole("link", { name: /Programa/ })).not.toHaveAttribute("aria-current");
  });

  it("treats Inicio as active only on the exact root path", () => {
    render(<BottomNav items={ITEMS} currentPath="/" />);
    expect(screen.getByRole("link", { name: /Inicio/ })).toHaveAttribute("aria-current", "page");
  });

  it("announces the unread badge as part of the link name", () => {
    render(<BottomNav items={ITEMS} currentPath="/" />);
    expect(screen.getByRole("link", { name: /^Chat\s*, 3 mensajes sin leer$/ })).toBeInTheDocument();
  });

  it("uses a custom renderLink so it stays router-agnostic", () => {
    render(
      <BottomNav
        items={ITEMS}
        currentPath="/chat"
        renderLink={({ href, className, children, isActive, "aria-current": ariaCurrent }) => (
          <a href={`#${href}`} className={className} aria-current={ariaCurrent} data-active={isActive}>
            {children}
          </a>
        )}
      />
    );
    const chat = screen.getByRole("link", { name: /Chat/ });
    expect(chat).toHaveAttribute("href", "#/chat");
    expect(chat).toHaveAttribute("data-active", "true");
  });
});

describe("isPathActive", () => {
  it("matches sub-paths but not siblings with a shared prefix", () => {
    expect(isPathActive("/chat/familia", "/chat")).toBe(true);
    expect(isPathActive("/chatarra", "/chat")).toBe(false);
  });

  it("ignores trailing slashes", () => {
    expect(isPathActive("/galeria/", "/galeria")).toBe(true);
  });

  it("requires an exact match when end is set", () => {
    expect(isPathActive("/cuencada/2027/fotos", "/cuencada/2027", true)).toBe(false);
  });
});
