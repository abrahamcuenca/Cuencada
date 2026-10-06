import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  forecastUrl,
  readWidgetHeight,
  WEATHER_DEFAULT_HEIGHT,
  WEATHER_FRAME_ID,
  WEATHER_ORIGIN,
  WeatherWidget,
  weatherWidgetConfig
} from "./WeatherWidget";

const FORECAST = "https://forecast7.com/es/20d97n89d59/merida/";

function renderWidget(): HTMLIFrameElement {
  render(<WeatherWidget href={FORECAST} city="Mérida" state="Yucatán" />);
  const frame = screen.getByTitle("Clima en Mérida");
  if (!(frame instanceof HTMLIFrameElement)) throw new Error("Se esperaba un iframe.");
  return frame;
}

function frameWindow(frame: HTMLIFrameElement): Window {
  const win = frame.contentWindow;
  if (win === null) throw new Error("El iframe no tiene ventana.");
  return win;
}

function post(data: unknown, origin: string, source: Window | null): void {
  act(() => {
    window.dispatchEvent(new MessageEvent("message", { data, origin, source }));
  });
}

describe("WeatherWidget", () => {
  it("renders weatherwidget.io's frame sandboxed, lazily and without a referrer", () => {
    const frame = renderWidget();
    expect(frame).toHaveAttribute("src", "https://weatherwidget.io/w/");
    expect(frame).toHaveAttribute("sandbox", "allow-scripts allow-same-origin allow-popups");
    expect(frame).toHaveAttribute("referrerpolicy", "no-referrer");
    expect(frame).toHaveAttribute("loading", "lazy");
    expect(frame.style.height).toBe(`${WEATHER_DEFAULT_HEIGHT}px`);
    expect(document.querySelector("script")).toBeNull();
  });

  it("posts the legacy config to exactly the weatherwidget.io origin on load", () => {
    const frame = renderWidget();
    const postMessage = vi.spyOn(frameWindow(frame), "postMessage").mockImplementation(() => undefined);

    fireEvent.load(frame);

    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ id: WEATHER_FRAME_ID, href: FORECAST, label_1: "MÉRIDA, YUCATÁN", label_2: "CLIMA", theme: "original", font: null }),
      "https://weatherwidget.io"
    );
  });

  it("sizes the frame from height messages sent by that frame, clamped to 150–250px", () => {
    const frame = renderWidget();
    const source = frameWindow(frame);

    post({ wwId: WEATHER_FRAME_ID, wwHeight: 212 }, WEATHER_ORIGIN, source);
    expect(frame.style.height).toBe("212px");
    post({ wwId: WEATHER_FRAME_ID, wwHeight: 50_000 }, WEATHER_ORIGIN, source);
    expect(frame.style.height).toBe("250px");
    post({ wwId: WEATHER_FRAME_ID, wwHeight: 251 }, WEATHER_ORIGIN, source);
    expect(frame.style.height).toBe("250px");
    post({ wwId: WEATHER_FRAME_ID, wwHeight: 149 }, WEATHER_ORIGIN, source);
    expect(frame.style.height).toBe("150px");
    post({ wwId: WEATHER_FRAME_ID, wwHeight: -40 }, WEATHER_ORIGIN, source);
    expect(frame.style.height).toBe("150px");
    post({ wwId: WEATHER_FRAME_ID, wwHeight: 250 }, WEATHER_ORIGIN, source);
    expect(frame.style.height).toBe("250px");
  });

  it("ignores messages from other origins, other windows or with other shapes", () => {
    const frame = renderWidget();
    const source = frameWindow(frame);

    post({ wwId: WEATHER_FRAME_ID, wwHeight: 200 }, "https://evil.example", source);
    post({ wwId: WEATHER_FRAME_ID, wwHeight: 200 }, "https://weatherwidget.io.evil.example", source);
    post({ wwId: WEATHER_FRAME_ID, wwHeight: 200 }, "http://weatherwidget.io", source);
    post({ wwId: WEATHER_FRAME_ID, wwHeight: 200 }, WEATHER_ORIGIN, window);
    post({ wwId: WEATHER_FRAME_ID, wwHeight: 200 }, WEATHER_ORIGIN, null);
    post({ wwId: "otro", wwHeight: 200 }, WEATHER_ORIGIN, source);
    post({ wwId: WEATHER_FRAME_ID, wwHeight: "<script>" }, WEATHER_ORIGIN, source);
    post("200", WEATHER_ORIGIN, source);

    expect(frame.style.height).toBe(`${WEATHER_DEFAULT_HEIGHT}px`);
  });

  it("stops listening when unmounted", () => {
    const remove = vi.spyOn(window, "removeEventListener");
    render(<WeatherWidget href={FORECAST} city="Mérida" state="Yucatán" />).unmount();
    expect(remove).toHaveBeenCalledWith("message", expect.any(Function));
    remove.mockRestore();
  });
});

describe("forecastUrl", () => {
  it("accepts only https forecast7.com pages", () => {
    expect(forecastUrl(FORECAST)).toBe(FORECAST);
    expect(forecastUrl("http://forecast7.com/es/x/")).toBeNull();
    expect(forecastUrl("https://forecast7.com.evil.example/x/")).toBeNull();
    expect(forecastUrl("https://user@forecast7.com/x/")).toBeNull();
    expect(forecastUrl("javascript:alert(1)")).toBeNull();
    expect(forecastUrl(null)).toBeNull();
  });
});

describe("readWidgetHeight / weatherWidgetConfig", () => {
  it("accepts numeric-string heights like the loader does", () => {
    expect(readWidgetHeight({ wwId: WEATHER_FRAME_ID, wwHeight: "180" })).toBe(180);
    expect(readWidgetHeight({ wwId: WEATHER_FRAME_ID, wwHeight: Number.NaN })).toBeNull();
    expect(readWidgetHeight(null)).toBeNull();
  });

  it("sends every style key the loader sends, as null", () => {
    const config = weatherWidgetConfig(FORECAST, "Mérida", "Yucatán");
    expect(Object.keys(config)).toHaveLength(32);
    expect(config.scale).toBeNull();
    expect(config.basecolor).toBeNull();
  });
});
