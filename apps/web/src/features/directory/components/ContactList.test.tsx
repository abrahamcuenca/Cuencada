import type { ContactItem } from "@cuencada/types";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SAMPLE_CARD } from "../testUtils";
import { CONTACT_LINK_REL, ContactList } from "./ContactList";

const EMAIL: ContactItem = { kind: "email", label: "Correo", href: "mailto:rosa@example.com", display: "rosa@example.com" };

describe("ContactList", () => {
  it("lists each contact with its label and the server's display text, hrefs as-is", () => {
    render(<ContactList contacts={[EMAIL, ...SAMPLE_CARD]} ownerName="Rosa" />);

    const list = screen.getByRole("list", { name: "Contacto de Rosa" });
    const links = within(list).getAllByRole("link");
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      "mailto:rosa@example.com",
      "tel:+525550100101",
      "https://wa.me/525550100101",
      "https://instagram.com/rosa.ejemplo"
    ]);
    expect(links[3]).toHaveTextContent("Instagram@rosa.ejemplo");
    // Phones are grouped for reading; the href keeps the E.164 number.
    expect(links[1]).toHaveTextContent("Teléfono+52 555 010 0101");
    expect(links[2]).toHaveTextContent("WhatsApp+52 555 010 0101");
  });

  it("opens https links in a new tab with noopener noreferrer nofollow, and tel:/mailto: natively", () => {
    render(<ContactList contacts={[EMAIL, ...SAMPLE_CARD]} />);

    const [mail, tel, whatsapp, instagram] = screen.getAllByRole("link");
    for (const link of [whatsapp, instagram]) {
      expect(link).toHaveAttribute("target", "_blank");
      expect(link).toHaveAttribute("rel", CONTACT_LINK_REL);
      expect(CONTACT_LINK_REL.split(" ")).toEqual(expect.arrayContaining(["noopener", "noreferrer"]));
    }
    for (const link of [mail, tel]) {
      expect(link).not.toHaveAttribute("target");
      expect(link).not.toHaveAttribute("rel");
    }
  });

  it("drops any item whose href is not https, mailto or tel:+digits (defense in depth)", () => {
    const hostile = [
      { kind: "website", label: "Sitio web", href: "javascript:alert(1)", display: "x" },
      { kind: "website", label: "Sitio web", href: "http://example.com", display: "x" },
      { kind: "phone", label: "Teléfono", href: "tel:5550100101", display: "x" }
    ] satisfies ContactItem[];
    render(<ContactList contacts={[...hostile, EMAIL]} emptyText="Nada" />);

    expect(screen.getAllByRole("link")).toHaveLength(1);
    expect(screen.getByRole("link")).toHaveAttribute("href", "mailto:rosa@example.com");
  });

  it("renders round icon chips with the label, owner and value as accessible name", () => {
    render(<ContactList contacts={SAMPLE_CARD} variant="chips" ownerName="Rosa" />);

    expect(screen.getByRole("link", { name: "Teléfono de Rosa: +52 555 010 0101" })).toHaveAttribute("href", "tel:+525550100101");
    expect(screen.getByRole("link", { name: "Instagram de Rosa: @rosa.ejemplo (se abre en otra pestaña)" })).toHaveAttribute("target", "_blank");
    // Inline SVG icons only: no images, no icon-font text.
    expect(document.querySelectorAll("svg[aria-hidden='true']")).toHaveLength(3);
    expect(document.querySelector("img")).toBeNull();
  });

  it("shows the empty text, or nothing, when there is no contact", () => {
    const { container, rerender } = render(<ContactList contacts={[]} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<ContactList contacts={[]} emptyText="No comparte datos de contacto." />);
    expect(screen.getByText("No comparte datos de contacto.")).toBeInTheDocument();
  });
});
