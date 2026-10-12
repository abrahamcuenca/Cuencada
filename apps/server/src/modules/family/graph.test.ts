/** WP-6.4: the in-memory family graph walks (pure). */
import { RelationshipKind } from "@cuencada/types";
import { describe, expect, it } from "vitest";
import { buildFamilyGraph, componentOf, components, outlineChildren, outlinePath } from "./graph.js";
import { disconnectedComponents, extendedBandIds, outlineEntries } from "./oneTree.js";

const parent = (from: string, to: string) => ({ kind: RelationshipKind.ParentOf, fromPersonId: from, toPersonId: to });
const partner = (from: string, to: string) => ({ kind: RelationshipKind.PartnerOf, fromPersonId: from, toPersonId: to });

describe("graph walks", () => {
  const graph = buildFamilyGraph(
    [parent("root", "a"), partner("root", "rp"), parent("rp", "b"), parent("a", "a1"), parent("b", "b1"), parent("x", "y")],
    ["lonely"]
  );

  it("shows a couple's children under either partner, never the partner itself", () => {
    expect(outlineChildren(graph, "root").sort()).toEqual(["a", "b"]);
    expect(outlineChildren(graph, "rp").sort()).toEqual(["a", "b"]);
  });

  it("finds components (isolated people included) and the outline path", () => {
    expect(componentOf(graph, "a1")).toEqual(new Set(["root", "a", "rp", "b", "a1", "b1"]));
    expect(components(graph).map((component) => component.size).sort()).toEqual([1, 2, 6]);
    expect(outlinePath(graph, "root", "b1", 64)).toEqual(["root", "b", "b1"]);
    expect(outlinePath(graph, "root", "y", 64)).toEqual([]);
    expect(outlinePath(graph, "root", "b1", 2)).toEqual([]);
  });

  it("caps the outline and shows a person reached twice once", () => {
    const married = buildFamilyGraph([parent("r", "c1"), parent("r", "c2"), parent("c1", "g"), parent("c2", "g")]);
    const entries = outlineEntries(married, "r", 3, 500);
    expect(entries.filter((entry) => entry.id === "g")).toHaveLength(1);
    expect(outlineEntries(married, "r", 3, 2)).toHaveLength(2);
  });

  it("terminates on cycles", () => {
    const cyclic = buildFamilyGraph([parent("p", "q"), parent("q", "p")]);
    expect(outlineEntries(cyclic, "p", 3, 500).map((entry) => entry.id)).toEqual(["p", "q"]);
    expect(outlinePath(cyclic, "p", "missing", 64)).toEqual([]);
    expect(extendedBandIds(cyclic, "p")).toEqual({ tios: [], primos: [], tiosAbuelos: [] });
  });

  it("lists components the root cannot reach, largest first", () => {
    expect(disconnectedComponents(graph, "root", false).branches.map((branch) => branch.members.length)).toEqual([2]);
    expect(disconnectedComponents(graph, "root", true).branches.map((branch) => branch.members.length)).toEqual([2, 1]);
    expect(disconnectedComponents(graph, null, false).main.has("root")).toBe(true);
  });
});
