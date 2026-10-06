import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { fixtureId, makeItinerary } from "../testing/fixtures";
import styles from "./content.module.css";
import { ProgramaTimeline } from "./ProgramaTimeline";

describe("ProgramaTimeline", () => {
  it("shows the item's tags as chips before the derived ones, as plain text", () => {
    const item = makeItinerary({
      id: fixtureId(901),
      title: "Cenote",
      description: "Paseo.",
      tags: ["Incluye comida", "<b>Traje de baño</b>"],
      locationName: "Cenote Santa Bárbara"
    });
    render(<ProgramaTimeline items={[item]} timeZone="America/Merida" />);

    const card = screen.getByRole("heading", { name: "Cenote" }).closest("li");
    if (card === null) throw new Error("missing item");
    const chips = within(card).getAllByText(/Incluye comida|Traje de baño|Cenote Santa Bárbara/);
    expect(chips.map((chip) => chip.textContent)).toEqual(["Incluye comida", "<b>Traje de baño</b>", "📍 Cenote Santa Bárbara"]);
    expect(card.querySelector("b")).toBeNull();
  });

  it("renders no tag chips for an item without tags or derived chips", () => {
    const item = makeItinerary({ id: fixtureId(902), title: "Desayuno", tags: [], locationName: null, startTime: "08:00", visibility: "public" });
    render(<ProgramaTimeline items={[item]} timeZone="America/Merida" />);

    const card = screen.getByRole("heading", { name: "Desayuno" }).closest("li");
    expect(card?.querySelector(`.${styles.tags}`)).toBeNull();
  });
});
