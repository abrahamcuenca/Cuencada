/**
 * Family-tree fixtures (T6). Insert straight into the worker database,
 * bypassing the service checks, so tests can also build corrupt data
 * (cycles, too many parents).
 */
import { RelationshipKind } from "@cuencada/types";
import { people, personRelationships } from "../../src/db/schema/index.js";
import { getTestDb } from "./db.js";

type PersonRow = typeof people.$inferSelect;
type RelationshipRow = typeof personRelationships.$inferSelect;

/**
 * Insert a person.
 *
 * @param values - Overrides; `fullName` defaults to a unique placeholder.
 */
export async function insertPerson(values: Partial<typeof people.$inferInsert> = {}): Promise<PersonRow> {
  const [row] = await getTestDb()
    .insert(people)
    .values({ fullName: `Persona ${Math.random().toString(36).slice(2, 8)}`, ...values })
    .returning();
  if (!row) throw new Error("insertPerson: no row");
  return row;
}

/**
 * Insert a `parent_of` edge directly (no cycle or parent-count check).
 *
 * @param parentId - Parent.
 * @param childId - Child.
 */
export async function insertParentOf(parentId: string, childId: string): Promise<RelationshipRow> {
  const [row] = await getTestDb()
    .insert(personRelationships)
    .values({ kind: RelationshipKind.ParentOf, fromPersonId: parentId, toPersonId: childId })
    .returning();
  if (!row) throw new Error("insertParentOf: no row");
  return row;
}

/**
 * Insert a `partner_of` edge directly.
 *
 * @param aId - One partner.
 * @param bId - The other.
 */
export async function insertPartnerOf(aId: string, bId: string): Promise<RelationshipRow> {
  const [row] = await getTestDb()
    .insert(personRelationships)
    .values({ kind: RelationshipKind.PartnerOf, fromPersonId: aId, toPersonId: bId })
    .returning();
  if (!row) throw new Error("insertPartnerOf: no row");
  return row;
}

/**
 * A straight line of `generations` people, each the parent of the next
 * (index 0 is the oldest).
 *
 * @param generations - Number of people.
 * @param prefix - Name prefix.
 */
export async function insertLineage(generations: number, prefix = "Gen"): Promise<PersonRow[]> {
  const line: PersonRow[] = [];
  for (let index = 0; index < generations; index += 1) {
    const person = await insertPerson({ fullName: `${prefix} ${index}` });
    const previous = line.at(-1);
    if (previous !== undefined) await insertParentOf(previous.id, person.id);
    line.push(person);
  }
  return line;
}
