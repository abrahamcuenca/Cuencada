/**
 * WP-4.5: "Posibles duplicados", "Fusionar con…", the merge preview sheet,
 * its confirmation, and "Deshacer" after a merge. Fictional people only.
 */
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { authenticatedState, makeUser } from "../../../../test/auth";
import { createTestServer } from "../../../../test/msw";
import { renderApp } from "../../../../test/renderApp";
import { type FamilyDb, familyHandlers, fixtureId, IDS, makeFamilyDb, makeRevision } from "../testing/fixtures";
import { addDuplicate, DUPLICATE_ID, makeMergeState, makePair, type MergeState, mergeHandlers } from "../testing/mergeFixtures";
import { revisionSummary } from "./components/RevisionList";
import { mergeConfirmText } from "./components/MergeSheet";
import { describeCandidate, describeSelfEdge, formatMergeValue } from "./lib/merge";

const server = createTestServer();
let db: FamilyDb;
let state: MergeState;
const admin = makeUser({ role: "admin" });

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterAll(() => server.close());
beforeEach(() => {
  db = makeFamilyDb();
  state = makeMergeState();
  server.use(...mergeHandlers(db, state), ...familyHandlers(db));
});
afterEach(() => server.resetHandlers());

function writes(): FamilyDb["log"] {
  return db.log.filter((entry) => entry.method !== "GET");
}

describe("merge helpers", () => {
  it("formats values, pairs and the merge row of the history", () => {
    const values = { fullName: "Raúl", nickname: null, familyBranch: null, birthYear: 1981, birthDate: "1981-07-09", deathYear: null, deathDate: null, deceased: false, birthplace: null, bio: null };
    expect(formatMergeValue("nickname", values)).toBe("Sin dato");
    expect(formatMergeValue("birthDate", values)).toBe("9 de julio de 1981");
    expect(formatMergeValue("deceased", values)).toBe("Vive");
    expect(describeSelfEdge({ kind: "partner_of" })).toBe("Relación entre las dos personas (pareja)");
    expect(
      describeCandidate({ id: IDS.raul, fullName: "Raúl", nickname: null, familyBranch: "Rama Norte", birthYear: 1981, deathYear: null, deceased: false, linked: true, relationshipCount: 1 })
    ).toBe("n. 1981 · Rama Norte · con cuenta · 1 relación");
    expect(mergeConfirmText("Raúl Herrera Morales", "Raúl Herrera M.")).toMatch(/^Esta acción combina a las dos personas en una sola: Raúl Herrera M\. desaparece/);
    const person = (id: string, fullName: string) => ({ type: "person" as const, personId: id, id, userId: null, ...values, fullName });
    const merge = makeRevision(1, {
      action: "person.merge",
      before: {
        type: "merge",
        personId: IDS.raul,
        id: IDS.raul,
        duplicatePersonId: DUPLICATE_ID,
        keep: person(IDS.raul, "Raúl Herrera Morales"),
        duplicate: person(DUPLICATE_ID, "Raúl Herrera M."),
        duplicateCreatedByUserId: null,
        keepRelationshipIds: [],
        relationships: [],
        photo: { keep: false, duplicate: false, moved: false, duplicateUpdatedAt: null },
        invites: { moved: [], revoked: [] },
        attendance: { moved: [], droppedCuencadaIds: [] }
      },
      after: person(IDS.raul, "Raúl Herrera Morales")
    });
    expect(revisionSummary(merge)).toBe("Fusionó a dos personas: «Raúl Herrera M.» en «Raúl Herrera Morales»");
  });
});

describe("Actividad del árbol · Posibles duplicados", { timeout: 20_000 }, () => {
  it("lists pairs, reviews one, merges after the confirmation, opens the kept person and offers «Deshacer»", async () => {
    const user = userEvent.setup();
    addDuplicate(db);
    state.pairs = [makePair(db, IDS.raul, DUPLICATE_ID)];
    db.revisions = [makeRevision(1, { id: fixtureId(750), action: "person.merge", revertible: true })];
    renderApp("/admin/familia/actividad?vista=duplicados", authenticatedState(admin));

    const region = await screen.findByRole("region", { name: "Posibles duplicados" });
    const pair = await within(region).findByRole("listitem", { name: "Raúl Herrera Morales y Raúl Herrera M." });
    expect(within(pair).getByText("Nombre parecido (un apellido de más)")).toBeInTheDocument();
    expect(within(pair).getByText(/n\. 1981 · Herrera Navarro · sin cuenta/)).toBeInTheDocument();
    await user.click(within(pair).getByRole("button", { name: "Revisar: Raúl Herrera Morales y Raúl Herrera M." }));

    const sheet = await screen.findByRole("dialog", { name: "Fusionar personas" });
    expect(await within(sheet).findByText("Se queda")).toBeInTheDocument();
    expect(within(sheet).getByText(/Cuenta: Cuenta de Raúl Herrera M\./)).toBeInTheDocument();
    // Differing fields get a choice; the defaults keep Raúl's values and fill his blanks.
    const nickname = within(sheet).getByRole("group", { name: "Apodo" });
    expect(within(nickname).getByRole("radio", { name: /Rulo/ })).toBeChecked();
    const name = within(sheet).getByRole("group", { name: "Nombre completo" });
    expect(within(name).getByRole("radio", { name: /^Raúl Herrera Morales/ })).toBeChecked();
    await user.click(within(name).getByRole("radio", { name: /^Raúl Herrera M\./ }));
    // Relationships, account and photo.
    expect(within(sheet).getByRole("list", { name: "Relaciones que pasan a Raúl Herrera Morales" })).toHaveTextContent("Carmen Ficticio · pareja");
    expect(within(sheet).getByRole("list", { name: "Relaciones que se quitan" })).toHaveTextContent("José Herrera Navarro · madre o padre");
    expect(within(sheet).getByText("La cuenta de Cuenta de Raúl Herrera M. pasa a Raúl Herrera Morales.")).toBeInTheDocument();
    expect(writes()).toHaveLength(0);

    await user.click(within(sheet).getByRole("button", { name: "Fusionar" }));
    const confirm = await screen.findByRole("alertdialog", { name: "¿Fusionar a Raúl Herrera M. con Raúl Herrera Morales?" });
    expect(confirm).toHaveTextContent("Esta acción combina a las dos personas en una sola");
    expect(writes()).toHaveLength(0);
    await user.click(within(confirm).getByRole("button", { name: "Fusionar" }));

    await waitFor(() =>
      expect(writes()[0]).toMatchObject({
        method: "POST",
        path: `/admin/people/${IDS.raul}/merge`,
        body: { duplicateId: DUPLICATE_ID, fields: expect.objectContaining({ fullName: "duplicate", nickname: "duplicate" }) as unknown }
      })
    );
    expect(await screen.findByText("Fusionamos a Raúl Herrera M. con Raúl Herrera Morales.")).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Raúl Herrera Morales", level: 1 })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Deshacer" }));
    await waitFor(() => expect(writes()[1]).toMatchObject({ method: "POST", path: `/admin/revisions/${fixtureId(750)}/revert` }));
    expect(await screen.findByText("Deshicimos la fusión.")).toBeInTheDocument();
  });

  it("explains blockers and conflicts, and never offers «Fusionar» for them", async () => {
    const user = userEvent.setup();
    addDuplicate(db);
    db.people.set(IDS.raul, { ...(db.people.get(IDS.raul) ?? { id: IDS.raul } as never), userId: fixtureId(904) });
    state.previews.set(`${IDS.raul}:${DUPLICATE_ID}`, {
      relationships: {
        moved: [],
        dropped: [],
        conflicts: [{ id: fixtureId(702), kind: "parent_of", otherPersonId: IDS.valeria, otherPersonName: "Valeria Ortiz Herrera", role: "child", outcome: "moved", reason: "too_many_parents" }]
      }
    });
    state.pairs = [makePair(db, IDS.raul, DUPLICATE_ID)];
    renderApp("/admin/familia/actividad?vista=duplicados", authenticatedState(admin));
    await user.click(await screen.findByRole("button", { name: /^Revisar:/ }));
    const sheet = await screen.findByRole("dialog", { name: "Fusionar personas" });
    expect(await within(sheet).findByText(/Las dos personas tienen su propia cuenta/)).toBeInTheDocument();
    const conflicts = within(sheet).getByRole("list", { name: "Relaciones con conflicto" });
    expect(conflicts).toHaveTextContent("Valeria Ortiz Herrera · hija o hijo");
    expect(conflicts).toHaveTextContent("Alguien quedaría con más de dos padres.");
    expect(within(sheet).getByRole("button", { name: "Fusionar" })).toBeDisabled();
  });

  it("blocks merged dates that break a rule until a coherent choice is made", async () => {
    const user = userEvent.setup();
    addDuplicate(db, { birthYear: 1982, birthDate: "1982-07-09", userId: null });
    state.pairs = [makePair(db, IDS.raul, DUPLICATE_ID)];
    renderApp("/admin/familia/actividad?vista=duplicados", authenticatedState(admin));
    await user.click(await screen.findByRole("button", { name: /^Revisar:/ }));
    const sheet = await screen.findByRole("dialog", { name: "Fusionar personas" });
    const date = await within(sheet).findByRole("group", { name: "Fecha de nacimiento" });
    await user.click(within(date).getByRole("radio", { name: /9 de julio de 1982/ }));
    expect(within(sheet).getByText(/Revisa las fechas:/)).toBeInTheDocument();
    expect(within(sheet).getByRole("button", { name: "Fusionar" })).toBeDisabled();
    await user.click(within(within(sheet).getByRole("group", { name: "Año de nacimiento" })).getByRole("radio", { name: /1982/ }));
    expect(within(sheet).queryByText(/Revisa las fechas:/)).not.toBeInTheDocument();
    expect(within(sheet).getByRole("button", { name: "Fusionar" })).toBeEnabled();
  });

  it("shows the server's reason when the merge is refused and keeps the sheet open", async () => {
    const user = userEvent.setup();
    addDuplicate(db);
    state.pairs = [makePair(db, IDS.raul, DUPLICATE_ID)];
    state.mergeError = { status: 409, code: "CONFLICT", message: "No se pueden fusionar: algunas relaciones romperían las reglas del árbol." };
    renderApp("/admin/familia/actividad?vista=duplicados", authenticatedState(admin));
    await user.click(await screen.findByRole("button", { name: /^Revisar:/ }));
    const sheet = await screen.findByRole("dialog", { name: "Fusionar personas" });
    await user.click(await within(sheet).findByRole("button", { name: "Fusionar" }));
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Fusionar" }));
    expect(await within(await screen.findByRole("dialog", { name: "Fusionar personas" })).findByText(/algunas relaciones romperían/)).toBeInTheDocument();
    expect(db.people.has(DUPLICATE_ID)).toBe(true);
  });

  it("says when there are no possible duplicates", async () => {
    renderApp("/admin/familia/actividad?vista=duplicados", authenticatedState(admin));
    expect(await screen.findByText("No encontramos posibles duplicados.")).toBeInTheDocument();
  });
});

describe("AdminPersonPage · Fusionar con…", { timeout: 20_000 }, () => {
  it("searches the duplicate, previews with this person kept, and can swap who stays", async () => {
    const user = userEvent.setup();
    addDuplicate(db);
    renderApp(`/admin/familia/${IDS.raul}`, authenticatedState(admin));
    await user.click(await screen.findByRole("button", { name: "Fusionar con…" }));
    const search = await screen.findByRole("dialog", { name: "Fusionar con…" });
    await user.type(within(search).getByRole("searchbox", { name: "Buscar persona" }), "Raúl Herrera");
    await user.click(await within(search).findByRole("button", { name: /^Elegir a Raúl Herrera M\./ }));
    const sheet = await screen.findByRole("dialog", { name: "Fusionar personas" });
    expect(await within(sheet).findByText("Raúl Herrera M. se combina con Raúl Herrera Morales, que es quien se queda en el árbol.")).toBeInTheDocument();
    expect(db.log.some((entry) => entry.path === `/admin/people/${IDS.raul}/merge-preview` && entry.search.includes(DUPLICATE_ID))).toBe(true);

    await user.click(within(sheet).getByRole("button", { name: "Cambiar cuál se queda" }));
    expect(await screen.findByText("Raúl Herrera Morales se combina con Raúl Herrera M., que es quien se queda en el árbol.")).toBeInTheDocument();
    expect(db.log.some((entry) => entry.path === `/admin/people/${DUPLICATE_ID}/merge-preview` && entry.search.includes(IDS.raul))).toBe(true);
    expect(writes()).toHaveLength(0);
  });
});
