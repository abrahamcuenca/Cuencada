import { screen, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { apiUrl, statusState } from "../../../../test/auth";
import { renderApp } from "../../../../test/renderApp";
import {
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
  )
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
