import { screen, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { apiUrl, authenticatedState, makeUser, statusState } from "../../../../test/auth";
import { renderApp } from "../../../../test/renderApp";
import { makeProfile } from "../../profile/testUtils";
import {
  makeAnnouncedCuencada,
  makeAnnouncedHome,
  makeDailyMessage,
  makeMemoriesHome,
  makePublicCuencada,
  makeSummary,
  fixtureId
} from "../testing/fixtures";

const server = setupServer(
  http.get(apiUrl("/cuencadas/home"), () => HttpResponse.json(makeMemoriesHome())),
  http.get(apiUrl("/cuencadas"), () =>
    HttpResponse.json([makeSummary(), makeSummary({ id: fixtureId(2024), year: 2024, title: "Cuencada 2024", city: "Oaxaca" })])
  ),
  // WP-4.7: members' "Completa tu perfil" card reads the own profile.
  http.get(apiUrl("/profile/me"), () => HttpResponse.json(makeProfile()))
);

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  server.resetHandlers();
  vi.useRealTimers();
});
afterAll(() => server.close());

describe("HomePage", () => {
  it("shows memories mode for a past edition: thanks, gallery link and past editions", async () => {
    renderApp("/", statusState("anonymous"));

    expect(await screen.findByText(/Gracias por acompañarnos\. La Cuencada 2026 en Mérida/)).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "CUENCADA" })).toBeInTheDocument();
    expect(screen.getByText("Una familia. Una historia. Una celebración.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Ver recuerdos de 2026/ })).toHaveAttribute("href", "/galeria/2026");
    expect(screen.queryByRole("timer")).not.toBeInTheDocument();

    const past = await screen.findByRole("region", { name: /Cuencadas anteriores/ });
    expect(within(past).getByRole("link", { name: /2024/ })).toHaveAttribute("href", "/cuencada/2024");
    // Portal-wide public announcement from the home response.
    expect(screen.getByRole("heading", { name: "¡Gracias por venir!" })).toBeInTheDocument();
  });

  it("shows the upcoming hero with a live countdown, Ver programa and the RSVP slot", async () => {
    // 03:00 UTC on Sep 10 is still Sep 9 in Mérida: the message dated Sep 9 is today's.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-10T03:00:00Z"));
    const featured = makePublicCuencada({ status: "upcoming", todayMessage: makeDailyMessage({ date: "2026-09-09", message: "¡Faltan pocos días!" }) });
    server.use(http.get(apiUrl("/cuencadas/home"), () => HttpResponse.json({ mode: "upcoming", featured, latestPast: null, announcements: [] })));
    renderApp("/", statusState("anonymous"));

    const timer = await screen.findByRole("timer");
    expect(timer).toHaveAccessibleName(/Faltan 3 días, 3 horas y 0 minutos/);
    expect(screen.getByRole("link", { name: /Ver programa/ })).toHaveAttribute("href", "/cuencada/2026#programa");
    expect(screen.getByText(/Mérida · Yucatán · 13—18 de septiembre de 2026/)).toBeInTheDocument();
    // T3: the RSVP card renders nothing (and calls no API) for visitors.
    expect(document.querySelector('[data-slot="rsvp"]')).toBeNull();
    expect(screen.getByRole("complementary", { name: "Mensaje del día" })).toHaveTextContent("¡Faltan pocos días!");
  });

  it("shows an announced edition without a countdown: year, Fecha y lugar por anunciar and the previous memories", async () => {
    server.use(http.get(apiUrl("/cuencadas/home"), () => HttpResponse.json(makeAnnouncedHome())));
    renderApp("/", statusState("anonymous"));

    expect(await screen.findByRole("heading", { level: 1, name: "Cuencada 2027" })).toBeInTheDocument();
    expect(screen.getByTestId("announced-pending")).toHaveTextContent("Fecha y lugar por anunciar");
    expect(screen.queryByRole("timer")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Ver Cuencada 2027/ })).toHaveAttribute("href", "/cuencada/2027");
    expect(screen.getByRole("link", { name: /Ver recuerdos de 2026/ })).toHaveAttribute("href", "/galeria/2026");
    // The previous edition's photos section stays; the "no date yet" card of memories mode does not.
    expect(screen.getByRole("region", { name: /Últimos momentos/ })).toBeInTheDocument();
    expect(screen.queryByText(/Todavía no tiene fecha/)).not.toBeInTheDocument();
  });

  it("shows the place when an announced edition already has one", async () => {
    const featured = makeAnnouncedCuencada({ city: "Valladolid", state: "Yucatán" });
    server.use(http.get(apiUrl("/cuencadas/home"), () => HttpResponse.json(makeAnnouncedHome({ featured, latestPast: null }))));
    renderApp("/", statusState("anonymous"));

    expect(await screen.findByTestId("announced-pending")).toHaveTextContent("Valladolid, Yucatán · Fecha por anunciar");
    expect(screen.queryByRole("link", { name: /Ver recuerdos/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("timer")).not.toBeInTheDocument();
  });

  it("hides a cached daily message that is not today's in the Cuencada's timezone", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-10T03:00:00Z"));
    // Sep 10 in UTC, but it is still Sep 9 in Mérida.
    const featured = makePublicCuencada({ status: "upcoming", todayMessage: makeDailyMessage({ date: "2026-09-10" }) });
    server.use(http.get(apiUrl("/cuencadas/home"), () => HttpResponse.json({ mode: "upcoming", featured, latestPast: null, announcements: [] })));
    renderApp("/", statusState("anonymous"));

    await screen.findByRole("timer");
    expect(screen.queryByRole("complementary", { name: "Mensaje del día" })).not.toBeInTheDocument();
  });

  it("refetches Home after local midnight in the edition's timezone and shows the new day's message", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    // 23:59:58 on Sep 9 in Mérida (UTC-6).
    vi.setSystemTime(new Date("2026-09-10T05:59:58Z"));
    let requests = 0;
    server.use(
      http.get(apiUrl("/cuencadas/home"), () => {
        requests += 1;
        const message =
          requests === 1 ? makeDailyMessage({ date: "2026-09-09", message: "Mensaje del 9" }) : makeDailyMessage({ date: "2026-09-10", message: "Mensaje del 10" });
        const featured = makePublicCuencada({ status: "upcoming", todayMessage: message });
        return HttpResponse.json({ mode: "upcoming", featured, latestPast: null, announcements: [] });
      })
    );
    renderApp("/", statusState("anonymous"));

    expect(await screen.findByText("Mensaje del 9")).toBeInTheDocument();
    await vi.advanceTimersByTimeAsync(4_000);

    expect(await screen.findByText("Mensaje del 10")).toBeInTheDocument();
    expect(screen.queryByText("Mensaje del 9")).not.toBeInTheDocument();
    expect(requests).toBe(2);
  });

  it("shows ¡YA LLEGÓ! when the server says the edition is active, even before startsAt on this device's clock", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-10T03:00:00Z"));
    const featured = makePublicCuencada({ status: "active", todayMessage: null });
    server.use(http.get(apiUrl("/cuencadas/home"), () => HttpResponse.json({ mode: "active", featured, latestPast: null, announcements: [] })));
    renderApp("/", statusState("anonymous"));

    expect(await screen.findByText("¡YA LLEGÓ LA CUENCADA!")).toBeInTheDocument();
    expect(screen.queryByRole("timer")).not.toBeInTheDocument();
  });

  it("shows visitors no family photos, only the brand art and a login teaser", async () => {
    renderApp("/", statusState("anonymous"));

    const memories = await screen.findByRole("region", { name: /Últimos momentos/ });
    expect(within(memories).getByText("Inicia sesión para ver las fotos de la familia")).toBeInTheDocument();
    expect(within(memories).getByRole("link", { name: "Iniciar sesión" })).toHaveAttribute("href", "/entrar");
    const sources = Array.from(document.querySelectorAll("img")).map((img) => img.getAttribute("src") ?? "");
    expect(sources.some((src) => /\/fotos\//.test(src) || src.includes("bucket"))).toBe(false);
  });

  it("asks members with an unverified email to verify before showing photos", async () => {
    server.use(http.get(apiUrl("/announcements"), () => HttpResponse.json({ items: [], nextCursor: null })));
    renderApp("/", authenticatedState(makeUser({ emailVerified: false })));

    const memories = await screen.findByRole("region", { name: /Últimos momentos/ });
    expect(within(memories).getByText("Verifica tu correo para ver las fotos de la familia")).toBeInTheDocument();
    expect(within(memories).getByText(/pide otro desde el aviso de arriba/)).toBeInTheDocument();
  });

  it("shows verified members the latest past edition's photos through the gallery preview", async () => {
    let mediaRequests = 0;
    server.use(
      http.get(apiUrl("/announcements"), () => HttpResponse.json({ items: [], nextCursor: null })),
      http.get(apiUrl("/cuencadas/2026/media"), () => {
        mediaRequests += 1;
        return HttpResponse.json({ items: [], nextCursor: null });
      })
    );
    renderApp("/", authenticatedState(makeUser()));

    const memories = await screen.findByRole("region", { name: /Últimos momentos/ });
    expect(await within(memories).findByRole("heading", { name: /Álbum vivo/ })).toBeInTheDocument();
    expect(within(memories).getByRole("link", { name: /Subir fotos|Ver álbum/ })).toHaveAttribute("href", "/galeria/2026");
    expect(mediaRequests).toBe(1);
    expect(within(memories).queryByText(/Inicia sesión para ver/)).not.toBeInTheDocument();
  });

  it("shows a coming-soon hero when there is no edition at all", async () => {
    server.use(
      http.get(apiUrl("/cuencadas/home"), () => HttpResponse.json(makeMemoriesHome({ latestPast: null, announcements: [] }))),
      http.get(apiUrl("/cuencadas"), () => HttpResponse.json([]))
    );
    renderApp("/", statusState("anonymous"));

    expect(await screen.findByText("Muy pronto anunciaremos la próxima Cuencada.")).toBeInTheDocument();
    expect(screen.queryByRole("timer")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Ver recuerdos/ })).not.toBeInTheDocument();
  });

  it("shows an offline state with Reintentar when the first load cannot reach the server", async () => {
    server.use(http.get(apiUrl("/cuencadas/home"), () => HttpResponse.error()));
    renderApp("/", statusState("anonymous"));

    expect(await screen.findByRole("heading", { name: "Sin conexión" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reintentar" })).toBeInTheDocument();
  });
});
