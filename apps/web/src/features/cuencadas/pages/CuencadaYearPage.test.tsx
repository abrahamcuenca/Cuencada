import { screen, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { apiUrl, authenticatedState, errorBody, makeUser, statusState } from "../../../../test/auth";
import { renderApp, warmRoutes } from "../../../../test/renderApp";
import { LINKS, makeAnnouncedCuencada, makeAnnouncement, makeMemberDetails, makePublicCuencada } from "../testing/fixtures";

let memberRequests = 0;

const server = setupServer(
  http.get(apiUrl("/cuencadas/2026"), () => HttpResponse.json(makePublicCuencada())),
  http.get(apiUrl("/cuencadas/2026/members"), () => {
    memberRequests += 1;
    return HttpResponse.json(makeMemberDetails());
  }),
  // T3 attendee strip: the member attended 2026, so the RSVP slot shows "Fuiste a esta Cuencada".
  http.get(apiUrl("/cuencadas/2026/attendees"), () =>
    HttpResponse.json([
      { personId: null, userId: makeUser().id, displayName: makeUser().displayName, avatarUrl: null, source: "rsvp", rsvpStatus: "yes", isMe: true }
    ])
  ),
  http.get(apiUrl("/cuencadas/1999"),() => HttpResponse.json(errorBody("NOT_FOUND", "No encontramos esa Cuencada."), { status: 404 }))
);

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
// Load the lazy page before the first test so its findBy* does not race a cold transform (WP-0.8a).
beforeAll(() => warmRoutes("/cuencada/2026"), 30_000);
afterEach(() => {
  server.resetHandlers();
  memberRequests = 0;
});
afterAll(() => server.close());

/** Intl uses narrow no-break spaces in times; normalise for readable assertions. */
function plain(value: string | null): string {
  return (value ?? "").replace(/[\u00a0\u202f]/g, " ");
}

describe("CuencadaYearPage", () => {
  it("shows the public sections and a lock card to anonymous visitors, without asking for member data", async () => {
    renderApp("/cuencada/2026", statusState("anonymous"));

    expect(await screen.findByRole("heading", { level: 1, name: "Cuencada 2026" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /Programa Cuencada 2026/ })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /¿Dónde estamos\?/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Abrir sitio del hotel/ })).toHaveAttribute("href", LINKS.hotel);
    expect(screen.getByRole("link", { name: /Abrir en Google Maps/ })).toHaveAttribute("href", LINKS.maps);

    const familia = screen.getByRole("region", { name: /Para la familia/ });
    expect(within(familia).getByText("Inicia sesión para ver fotos, asistentes y más.")).toBeInTheDocument();
    expect(within(familia).getByRole("link", { name: "Entrar" })).toHaveAttribute("href", "/entrar");
    expect(screen.queryByRole("link", { name: /Grupo WhatsApp/ })).not.toBeInTheDocument();
    expect(screen.queryByText("Cena familiar privada")).not.toBeInTheDocument();
    expect(memberRequests).toBe(0);
  });

  it("shows an announced edition with Por anunciar, no countdown and no empty programa, places or weather", async () => {
    server.use(
      http.get(apiUrl("/cuencadas/2027"), () => HttpResponse.json(makeAnnouncedCuencada({ weatherWidgetUrl: LINKS.weather })))
    );
    renderApp("/cuencada/2027", statusState("anonymous"));

    expect(await screen.findByRole("heading", { level: 1, name: "Cuencada 2027" })).toBeInTheDocument();
    expect(screen.getByText("Fecha y lugar por anunciar")).toBeInTheDocument();
    const facts = screen.getByTestId("pending-facts");
    expect(within(facts).getByText("Fechas:").nextElementSibling).toHaveTextContent("Por anunciar");
    expect(within(facts).getByText("Lugar:").nextElementSibling).toHaveTextContent("Por anunciar");
    expect(screen.queryByRole("timer")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /Programa Cuencada 2027/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /¿Dónde estamos\?/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Ver programa/ })).not.toBeInTheDocument();
    // No place yet, so no forecast to embed, even with a widget URL set.
    expect(screen.queryByRole("heading", { name: /Clima/ })).not.toBeInTheDocument();
    const nav = screen.getByRole("navigation", { name: "Secciones de la Cuencada" });
    expect(within(nav).getAllByRole("link").map((link) => link.textContent)).toEqual(["Familia"]);
    expect(screen.getByRole("region", { name: /Para la familia/ })).toBeInTheDocument();
  });

  it("shows the programa of an announced edition once it has items, and the place when set", async () => {
    server.use(
      http.get(apiUrl("/cuencadas/2027"), () =>
        HttpResponse.json(
          makeAnnouncedCuencada({ city: "Valladolid", state: "Yucatán", publicItinerary: makePublicCuencada().publicItinerary })
        )
      )
    );
    renderApp("/cuencada/2027", statusState("anonymous"));

    expect(await screen.findByRole("heading", { name: /Programa Cuencada 2027/ })).toBeInTheDocument();
    expect(screen.getByText("Valladolid · Yucatán · Fecha por anunciar")).toBeInTheDocument();
    expect(within(screen.getByTestId("pending-facts")).getByText("Valladolid, Yucatán")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /¿Dónde estamos\?/ })).not.toBeInTheDocument();
  });

  it("shows WhatsApp, the album, members-only items and the T3/T4 slots to members", async () => {
    renderApp("/cuencada/2026", authenticatedState());

    const familia = await screen.findByRole("region", { name: /Para la familia/ });
    // Legacy production links are rendered exactly as the API returns them.
    expect(await within(familia).findByRole("link", { name: /Grupo WhatsApp/ })).toHaveAttribute("href", LINKS.whatsapp);
    expect(within(familia).getByRole("link", { name: /Ver álbum compartido/ })).toHaveAttribute("href", LINKS.album);
    expect(within(familia).getByRole("heading", { name: "Ver letra oficial" })).toBeInTheDocument();
    expect(await within(familia).findByText("🎉 Fuiste a esta Cuencada")).toBeInTheDocument();
    for (const slot of ["rsvp", "attendees", "gallery"]) {
      expect(familia.querySelector(`[data-slot="${slot}"]`)).not.toBeNull();
    }
    expect(screen.getByRole("heading", { name: "Cena familiar privada" })).toBeInTheDocument();
    expect(screen.queryByText("Inicia sesión para ver fotos, asistentes y más.")).not.toBeInTheDocument();
    expect(memberRequests).toBe(1);
  });

  it("formats every date and time in the Cuencada's timezone (America/Merida)", async () => {
    server.use(
      http.get(apiUrl("/cuencadas/2026"), () => HttpResponse.json(makePublicCuencada({ publicAnnouncements: [makeAnnouncement()] })))
    );
    renderApp("/cuencada/2026", statusState("anonymous"));

    await screen.findByRole("heading", { level: 1, name: "Cuencada 2026" });
    // endsAt is 05:59:59Z on the 19th: still the 18th in Mérida.
    expect(screen.getByText("Mérida · Yucatán · 13—18 de septiembre de 2026")).toBeInTheDocument();
    // Wall-clock times are the Cuencada's, shown in 12-hour Spanish style.
    const cenote = screen.getByRole("heading", { name: "💦 Cenote & Izamal" }).closest("li");
    expect(plain(cenote?.textContent ?? null)).toContain("7:40 a.m. – 6:00 p.m. · $1,000 p/p");
    const day = cenote?.closest("ol > li");
    expect(plain(day?.textContent ?? null)).toMatch(/^14lunes/);
    // publishedAt is 03:30Z on Sep 1: still Aug 31 in Mérida.
    expect(screen.getByText(/Publicado el 31 de agosto de 2026/)).toBeInTheDocument();
  });

  it("embeds weatherwidget.io's own frame when configured and never adds a third-party script", async () => {
    const scriptsBefore = document.querySelectorAll("script").length;
    renderApp("/cuencada/2026", statusState("anonymous"));

    const frame = await screen.findByTitle("Clima en Mérida");
    expect(frame.tagName).toBe("IFRAME");
    // Boxed in a card inside the labelled "Clima en Mérida" section.
    const section = screen.getByRole("region", { name: /Clima en Mérida/ });
    expect(section).toContainElement(frame);
    expect(frame).toHaveAttribute("src", "https://weatherwidget.io/w/");
    expect(frame).toHaveAttribute("sandbox", "allow-scripts allow-same-origin allow-popups");
    expect(document.querySelector('script[src*="weatherwidget"]')).toBeNull();
    expect(document.querySelectorAll("script")).toHaveLength(scriptsBefore);
  });

  it("renders no weather widget when the Cuencada has no weatherWidgetUrl", async () => {
    server.use(http.get(apiUrl("/cuencadas/2026"), () => HttpResponse.json(makePublicCuencada({ weatherWidgetUrl: null }))));
    renderApp("/cuencada/2026", statusState("anonymous"));

    await screen.findByRole("heading", { level: 1, name: "Cuencada 2026" });
    expect(screen.queryByTitle(/Clima en/)).not.toBeInTheDocument();
    expect(document.querySelector("iframe")).toBeNull();
    expect(document.querySelector('script[src*="weatherwidget"]')).toBeNull();
  });

  it("plays the song with a native player that does not preload", async () => {
    renderApp("/cuencada/2026", statusState("anonymous"));

    await screen.findByRole("heading", { name: /Nuestra canción/ });
    const audio = document.querySelector("audio");
    expect(audio).toHaveAttribute("src", "/canciones/Cancion_Oficial.mp3");
    expect(audio).toHaveAttribute("preload", "none");
    expect(audio).toHaveAttribute("controls");
  });

  it("shows a 404 state for an unknown year", async () => {
    renderApp("/cuencada/1999", statusState("anonymous"));

    expect(await screen.findByRole("heading", { name: "No encontramos esa Cuencada" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Ir al inicio" })).toHaveAttribute("href", "/");
  });

  it("shows the 404 state without calling the API for a year that is not a number", async () => {
    renderApp("/cuencada/abc", statusState("anonymous"));

    expect(await screen.findByRole("heading", { name: "No encontramos esa Cuencada" })).toBeInTheDocument();
  });

  it("explains the members block needs a connection when member data cannot load offline", async () => {
    server.use(http.get(apiUrl("/cuencadas/2026/members"), () => HttpResponse.error()));
    renderApp("/cuencada/2026", authenticatedState());

    const familia = await screen.findByRole("region", { name: /Para la familia/ });
    expect(await within(familia).findByText("Necesitas conexión para ver la sección de la familia.")).toBeInTheDocument();
    // The public content stays on screen.
    expect(screen.getByRole("heading", { name: /Programa Cuencada 2026/ })).toBeInTheDocument();
  });

  // WP-2.3 M2: /members needs a verified email; a 403 is final, so no retry.
  it("shows the verify-email prompt (no retry, no member links) when /members answers 403 EMAIL_UNVERIFIED, keeping the public sections", async () => {
    server.use(
      http.get(apiUrl("/cuencadas/2026/members"), () => {
        memberRequests += 1;
        return HttpResponse.json(errorBody("EMAIL_UNVERIFIED", "Confirma tu correo electrónico para ver esta sección."), { status: 403 });
      })
    );
    renderApp("/cuencada/2026", authenticatedState(makeUser({ emailVerified: false })));

    const familia = await screen.findByRole("region", { name: /Para la familia/ });
    expect(
      await within(familia).findByRole("heading", { level: 3, name: "Verifica tu correo para ver la sección de la familia" })
    ).toBeInTheDocument();
    expect(within(familia).getByRole("button", { name: /Reenviar/ })).toBeInTheDocument();
    expect(within(familia).queryByRole("button", { name: "Reintentar" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Grupo WhatsApp/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Ver álbum compartido/ })).not.toBeInTheDocument();
    // Public content stays.
    expect(screen.getByRole("heading", { level: 1, name: "Cuencada 2026" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /Programa Cuencada 2026/ })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /¿Dónde estamos\?/ })).toBeInTheDocument();
    expect(memberRequests).toBe(1);
  });

  it("shows the no-access copy without a retry for any other 403 on /members", async () => {
    server.use(
      http.get(apiUrl("/cuencadas/2026/members"), () => HttpResponse.json(errorBody("FORBIDDEN", "Sin acceso."), { status: 403 }))
    );
    renderApp("/cuencada/2026", authenticatedState());

    const familia = await screen.findByRole("region", { name: /Para la familia/ });
    expect(await within(familia).findByRole("heading", { level: 3, name: "No tienes acceso a la sección de la familia" })).toBeInTheDocument();
    expect(within(familia).queryByRole("button", { name: "Reintentar" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /Programa Cuencada 2026/ })).toBeInTheDocument();
  });
});
