/**
 * WP-4.4: `loadPersonContactRows` / `personContactCard` (used by WP-4.1's
 * `PersonDetails`). Fictional fixtures only.
 */
import { describe, expect, it } from "vitest";
import { getTestDb } from "../../../test/helpers/db.js";
import { createUser } from "../../../test/helpers/factories.js";
import { loadPersonContactRows, personContactCard } from "./personContacts.js";

describe("loadPersonContactRows", () => {
  it("returns an empty map without querying for no ids", async () => {
    expect((await loadPersonContactRows(getTestDb(), [])).size).toBe(0);
  });

  it("loads the contact columns of listed, active accounts in one query, keyed by user id", async () => {
    const a = await createUser({
      emailVerified: true,
      email: "tia.ficticia@example.com",
      profile: { phone: "+525550100101", instagram: "tia.ficticia", showEmail: true, contactVisibility: { instagram: true } }
    });
    const b = await createUser({ emailVerified: true, profile: { github: "primo-ficticio" } });

    const rows = await loadPersonContactRows(getTestDb(), [a.id, b.id, a.id]);

    expect(rows.size).toBe(2);
    expect(rows.get(a.id)).toMatchObject({
      email: "tia.ficticia@example.com",
      phone: "+525550100101",
      instagram: "tia.ficticia",
      showEmail: true,
      showPhone: false,
      contactVisibility: { instagram: true }
    });
    expect(rows.get(b.id)?.github).toBe("primo-ficticio");
  });

  it("leaves out disabled and unlisted accounts (defense in depth)", async () => {
    const disabled = await createUser({ status: "disabled", profile: { instagram: "baja.ficticia" } });
    const unlisted = await createUser({ profile: { instagram: "oculta.ficticia", listedInDirectory: false } });

    const rows = await loadPersonContactRows(getTestDb(), [disabled.id, unlisted.id]);

    expect(rows.size).toBe(0);
  });
});

describe("personContactCard", () => {
  it("gives an empty card for no row", () => {
    expect(personContactCard(null)).toEqual([]);
  });

  it("applies each switch and drops hidden contacts entirely", async () => {
    const user = await createUser({
      email: "tio.ficticio@example.com",
      profile: {
        phone: "+525550100101",
        whatsapp: "+525550100101",
        instagram: "tio.ficticio",
        website: "https://example.com/",
        showEmail: true,
        showPhone: false,
        contactVisibility: { whatsapp: true, instagram: false }
      }
    });
    const row = (await loadPersonContactRows(getTestDb(), [user.id])).get(user.id) ?? null;

    expect(personContactCard(row)).toEqual([
      { kind: "email", label: "Correo", href: "mailto:tio.ficticio@example.com", display: "tio.ficticio@example.com" },
      { kind: "whatsapp", label: "WhatsApp", href: "https://wa.me/525550100101", display: "+525550100101" }
    ]);
  });
});
