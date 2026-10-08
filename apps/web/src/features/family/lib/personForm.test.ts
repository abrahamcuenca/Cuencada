import { describe, expect, it } from "vitest";
import { formatPersonDate } from "../components/PersonDetailsSection";
import { IDS, makePerson } from "../testing/fixtures";
import { changedPersonFields, editPersonField, emptyPersonValues, personValues, setDeceased, toPersonFields } from "./personForm";

describe("editPersonField", () => {
  it("fills the year from a full date", () => {
    expect(editPersonField(emptyPersonValues(), "birthDate", "1950-03-04")).toMatchObject({ birthDate: "1950-03-04", birthYear: "1950" });
    expect(editPersonField(emptyPersonValues(), "deathDate", "2001-12-31")).toMatchObject({ deathYear: "2001" });
  });

  it("clears the date when its year is cleared or changed, and keeps it when the year still matches", () => {
    const dated = editPersonField(emptyPersonValues(), "birthDate", "1950-03-04");
    expect(editPersonField(dated, "birthYear", "")).toMatchObject({ birthYear: "", birthDate: "" });
    expect(editPersonField(dated, "birthYear", "1951")).toMatchObject({ birthDate: "" });
    expect(editPersonField(dated, "birthYear", "1950")).toMatchObject({ birthDate: "1950-03-04" });
    const died = editPersonField({ ...emptyPersonValues(), deceased: true }, "deathDate", "2001-05-05");
    expect(editPersonField(died, "deathYear", "")).toMatchObject({ deathYear: "", deathDate: "" });
  });
});

describe("setDeceased", () => {
  it("clears the death data when un-ticked", () => {
    const died = { ...emptyPersonValues(), deceased: true, deathYear: "2001", deathDate: "2001-05-05" };
    expect(setDeceased(died, false)).toMatchObject({ deceased: false, deathYear: "", deathDate: "" });
    expect(setDeceased(emptyPersonValues(), true).deceased).toBe(true);
  });
});

describe("toPersonFields / changedPersonFields", () => {
  it("converts blanks to null, malformed years to NaN, and drops death data of living people", () => {
    const values = { ...emptyPersonValues(" Ana Morales "), birthYear: "19x", deathYear: "2000", bio: "  " };
    const fields = toPersonFields(values);
    expect(fields).toMatchObject({ fullName: "Ana Morales", birthYear: Number.NaN, deathYear: null, bio: null, nickname: null });
  });

  it("sends only the fields that changed", () => {
    const person = makePerson(IDS.raul, "Raúl Herrera Morales", { birthYear: 1981, birthDate: "1981-02-03", birthplace: "Pueblo Norte" });
    const values = personValues(person);
    expect(changedPersonFields(person, values)).toEqual({});
    expect(changedPersonFields(person, { ...values, nickname: "Rulo", bio: "Músico." })).toEqual({ nickname: "Rulo", bio: "Músico." });
    expect(changedPersonFields(person, editPersonField(values, "birthYear", ""))).toEqual({ birthYear: null, birthDate: null });
  });
});

describe("formatPersonDate", () => {
  it("formats a calendar date in Spanish without shifting the day", () => {
    expect(formatPersonDate("1950-03-04")).toBe("4 de marzo de 1950");
    expect(formatPersonDate("2001-01-01")).toBe("1 de enero de 2001");
  });
});
