import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Countdown, getCountdown } from "./Countdown";

// 2027-09-12 00:00 in Mérida (UTC-6)
const START = new Date("2027-09-12T00:00:00-06:00");
const END = new Date("2027-09-17T23:59:59-06:00");

describe("getCountdown", () => {
  it("splits the remaining time into days, hours, minutes and seconds", () => {
    const now = new Date(START.getTime() - (3 * 86_400 + 4 * 3_600 + 5 * 60 + 6) * 1000);
    expect(getCountdown(START, now, END)).toEqual({ phase: "upcoming", days: 3, hours: 4, minutes: 5, seconds: 6 });
  });

  it("is live exactly at the start instant", () => {
    expect(getCountdown(START, START, END).phase).toBe("live");
  });

  it("stays live forever when no end is given", () => {
    expect(getCountdown(START, END.getTime() + 1e10).phase).toBe("live");
  });

  it("is past once now reaches the end", () => {
    expect(getCountdown(START, END, END).phase).toBe("past");
  });

  it("accepts epoch milliseconds as well as dates", () => {
    expect(getCountdown(START.getTime(), START.getTime() - 1000, END.getTime())).toMatchObject({ phase: "upcoming", seconds: 1 });
  });
});

describe("Countdown", () => {
  it("renders the four units with a spoken summary while upcoming", () => {
    const now = new Date(START.getTime() - (1 * 86_400 + 2 * 3_600 + 3 * 60 + 9) * 1000);
    render(<Countdown target={START} now={now} end={END} />);
    const timer = screen.getByRole("timer");
    expect(timer).toHaveAccessibleName("Faltan 1 día, 2 horas y 3 minutos");
    expect(timer).toHaveTextContent("1día02horas03minutos09segundos");
  });

  it("celebrates while the Cuencada is happening", () => {
    render(<Countdown target={START} now={START.getTime() + 60_000} end={END} />);
    expect(screen.getByText("¡YA LLEGÓ LA CUENCADA!")).toBeInTheDocument();
    expect(screen.queryByRole("timer")).not.toBeInTheDocument();
  });

  it("shows the past message after the end", () => {
    render(<Countdown target={START} now={END.getTime() + 1} end={END} pastMessage="La Cuencada 2027 ya es parte de nuestra historia." />);
    expect(screen.getByText("La Cuencada 2027 ya es parte de nuestra historia.")).toBeInTheDocument();
  });
});
