import type { OwnProfile } from "@cuencada/types";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { authenticatedState } from "../../../../test/auth";
import { createTestServer } from "../../../../test/msw";
import { renderApp } from "../../../../test/renderApp";
import { emptyContacts, type FakeProfileDb, makeProfile, makeProfileDb, profileHandlers } from "../testUtils";

const server = createTestServer();
let db: FakeProfileDb;

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterAll(() => server.close());
afterEach(() => server.resetHandlers());

function seedProfile(overrides: Partial<OwnProfile> = {}): void {
  const base = makeProfile({ visibility: { showEmail: false, showPhone: false, showCity: true, listedInDirectory: true }, ...overrides });
  db = makeProfileDb({ ...base, contacts: overrides.contacts ?? emptyContacts(base) });
  server.use(...profileHandlers(db));
}

beforeEach(() => seedProfile());

async function openContacto(): Promise<{ user: ReturnType<typeof userEvent.setup>; form: HTMLElement }> {
  const user = userEvent.setup();
  renderApp("/perfil", authenticatedState());
  const form = await screen.findByRole("form", { name: "Contacto" });
  return { user, form };
}

function visibleSwitch(form: HTMLElement, label: string): HTMLElement {
  return within(form).getByRole("switch", { name: `Mostrar a la familia (${label})` });
}

describe("ContactSection", () => {
  it("shows every contact with a 'Mostrar a la familia' switch off by default and +52 preselected", async () => {
    const { form } = await openContacto();

    for (const label of ["Correo", "Teléfono", "WhatsApp", "Instagram", "Facebook", "TikTok", "LinkedIn", "GitHub", "Sitio web"]) {
      expect(visibleSwitch(form, label)).not.toBeChecked();
    }
    expect(within(form).getByRole("combobox", { name: "País (lada) de teléfono" })).toHaveValue("52");
    expect(within(form).getByRole("checkbox", { name: "Usar mi teléfono" })).toBeChecked();
    expect(within(form).getByLabelText(/^Instagram/)).toHaveAccessibleDescription(/Solo tu usuario/);
    expect(within(form).getByText("prima@example.com")).toBeInTheDocument();
    expect(within(form).getByText(/todos los familiares con cuenta verificada/)).toBeInTheDocument();
    expect(within(form).getByRole("button", { name: "Guardar contacto" })).toBeDisabled();
  });

  it("sends only what changed: E.164 phone, WhatsApp from the phone, a bare handle and three switches", async () => {
    const { user, form } = await openContacto();

    await user.type(within(form).getByLabelText(/^Teléfono/), "555 010 0101");
    await user.type(within(form).getByLabelText(/^Instagram/), "@prima.ejemplo");
    await user.click(visibleSwitch(form, "Teléfono"));
    await user.click(visibleSwitch(form, "WhatsApp"));
    await user.click(visibleSwitch(form, "Instagram"));
    await user.click(within(form).getByRole("button", { name: "Guardar contacto" }));

    expect(await screen.findByText("Contacto guardado.")).toBeInTheDocument();
    expect(db.contactPatches).toEqual([
      { phone: "+525550100101", whatsapp: "+525550100101", instagram: "prima.ejemplo", visibility: { phone: true, whatsapp: true, instagram: true } }
    ]);
    // Nothing went through the old profile PATCH.
    expect(db.patches).toEqual([]);
    await waitFor(() => expect(within(form).getByRole("button", { name: "Guardar contacto" })).toBeDisabled());
    expect(visibleSwitch(form, "Instagram")).toBeChecked();
  });

  it("uses the country picker, and a number typed with its own +lada wins", async () => {
    const { user, form } = await openContacto();

    await user.selectOptions(within(form).getByRole("combobox", { name: "País (lada) de teléfono" }), "1");
    await user.type(within(form).getByLabelText(/^Teléfono/), "(202) 555-0147");
    await user.click(within(form).getByRole("checkbox", { name: "Usar mi teléfono" }));
    const whatsapp = within(form).getByLabelText(/^Número de WhatsApp/);
    // Pre-filled from the phone when switching to a separate number.
    expect(whatsapp).toHaveValue("(202) 555-0147");
    await user.clear(whatsapp);
    await user.type(whatsapp, "+34 612 345 678");
    await user.click(within(form).getByRole("button", { name: "Guardar contacto" }));

    await screen.findByText("Contacto guardado.");
    expect(db.contactPatches).toEqual([{ phone: "+12025550147", whatsapp: "+34612345678" }]);
  });

  it("shows a clear Spanish error for a pasted Instagram link and sends nothing", async () => {
    const { user, form } = await openContacto();

    const instagram = within(form).getByLabelText(/^Instagram/);
    await user.click(instagram);
    await user.paste("https://www.instagram.com/prima.ejemplo/");

    expect(within(form).getByText("Escribe solo tu usuario, sin el enlace.")).toBeInTheDocument();
    await user.click(within(form).getByRole("button", { name: "Guardar contacto" }));
    expect(instagram).toHaveAttribute("aria-invalid", "true");
    expect(instagram).toHaveFocus();
    expect(db.contactPatches).toEqual([]);
  });

  it("rejects an invalid handle and an http website with the contract's Spanish messages", async () => {
    const { user, form } = await openContacto();

    await user.type(within(form).getByLabelText(/^GitHub/), "prima--ejemplo");
    await user.type(within(form).getByLabelText(/^Sitio web/), "http://example.com");
    await user.click(within(form).getByRole("button", { name: "Guardar contacto" }));

    expect(await within(form).findByText(/Usuario de GitHub inválido/)).toBeInTheDocument();
    expect(within(form).getByText("El sitio web debe ser una dirección https:// válida.")).toBeInTheDocument();
    expect(db.contactPatches).toEqual([]);
  });

  it("warns softly about a website on a bare IP or a private name, but still saves it", async () => {
    const { user, form } = await openContacto();

    await user.type(within(form).getByLabelText(/^Sitio web/), "https://192.168.1.20/fotos");
    expect(within(form).getByLabelText(/^Sitio web/)).toHaveAccessibleDescription(/dirección privada o numérica/);
    await user.click(within(form).getByRole("button", { name: "Guardar contacto" }));

    await screen.findByText("Contacto guardado.");
    expect(db.contactPatches).toEqual([{ website: "https://192.168.1.20/fotos" }]);
  });

  it("maps the email switch to visibility.email", async () => {
    const { user, form } = await openContacto();

    await user.click(visibleSwitch(form, "Correo"));
    await user.click(within(form).getByRole("button", { name: "Guardar contacto" }));

    await screen.findByText("Contacto guardado.");
    expect(db.contactPatches).toEqual([{ visibility: { email: true } }]);
    expect(db.profile.visibility.showEmail).toBe(true);
  });

  it("asks to confirm a legacy phone without a country code and saves it with the picked lada", async () => {
    seedProfile({ phone: "55 1234 5678", phoneNeedsConfirmation: true });
    const { user, form } = await openContacto();

    expect(within(form).getByText("Confirma tu teléfono con la lada de tu país")).toBeInTheDocument();
    expect(within(form).getByLabelText(/^Teléfono/)).toHaveValue("55 1234 5678");
    // Saving is the confirmation: the button is ready without other edits.
    const save = within(form).getByRole("button", { name: "Guardar contacto" });
    expect(save).toBeEnabled();
    await user.click(save);

    await screen.findByText("Contacto guardado.");
    expect(db.contactPatches).toEqual([{ phone: "+525512345678" }]);
    await waitFor(() => expect(within(form).queryByText(/Confirma tu teléfono/)).toBeNull());
  });

  it("splits a stored E.164 phone into lada and number, and keeps 'Usar mi teléfono' on when WhatsApp matches", async () => {
    const base = makeProfile();
    seedProfile({ phone: "+12025550147", contacts: { ...emptyContacts(base), whatsapp: "+12025550147" } });
    const { form } = await openContacto();

    expect(within(form).getByRole("combobox", { name: "País (lada) de teléfono" })).toHaveValue("1");
    expect(within(form).getByLabelText(/^Teléfono/)).toHaveValue("2025550147");
    expect(within(form).getByRole("checkbox", { name: "Usar mi teléfono" })).toBeChecked();
    expect(within(form).queryByText(/Confirma tu teléfono/)).toBeNull();
    expect(within(form).getByRole("button", { name: "Guardar contacto" })).toBeDisabled();
  });

  it("shows the server error and keeps the edits", async () => {
    db.patchStatus = 500;
    const { user, form } = await openContacto();

    await user.type(within(form).getByLabelText(/^TikTok/), "prima_ejemplo");
    await user.click(within(form).getByRole("button", { name: "Guardar contacto" }));

    expect(await within(form).findByText("Algo salió mal en el servidor.")).toBeInTheDocument();
    expect(within(form).getByLabelText(/^TikTok/)).toHaveValue("prima_ejemplo");
  });
});
