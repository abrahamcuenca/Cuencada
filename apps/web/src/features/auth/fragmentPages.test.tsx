import { screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { statusState } from "../../../test/auth";
import { renderApp } from "../../../test/renderApp";
import { clearFragmentToken } from "../../shared/lib/fragmentToken";

const TOKEN = "Zt7".repeat(12);

afterEach(() => {
  clearFragmentToken();
  window.history.replaceState(null, "", "/");
});

describe("fragment-token pages", () => {
  it.each([
    ["/entrar/enlace", "Entrando con tu enlace"],
    ["/invitacion", "Únete a la familia"],
    ["/restablecer", "Nueva contraseña"],
    ["/verificar", "Verificar correo"]
  ])("scrub the token from the address bar when %s loads", async (path, heading) => {
    window.history.replaceState(null, "", `${path}#t=${TOKEN}`);

    renderApp(path, statusState("anonymous"));

    expect(await screen.findByRole("heading", { name: heading })).toBeInTheDocument();
    expect(screen.queryByText(/no es válido/)).not.toBeInTheDocument();
    expect(window.location.hash).toBe("");
    expect(window.location.href).not.toContain(TOKEN);
  });

  it("tells the user the link is invalid when /verificar has no token", async () => {
    window.history.replaceState(null, "", "/verificar");

    renderApp("/verificar", statusState("anonymous"));

    expect(await screen.findByText(/no es válido o está incompleto/)).toBeInTheDocument();
  });
});
