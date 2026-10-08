/**
 * Pure helpers for "Fusionar personas" (WP-4.5): Spanish labels and value
 * formatting for the merge preview. The server is the authority; these only
 * describe what it returned.
 */
import {
  type DuplicateCandidate,
  type DuplicateReason,
  FamilyIssueCode,
  type MergeConflictReason,
  type MergeEdgeRole,
  type PersonMergeEdge,
  type PersonMergeField,
  type PersonMergeValues,
  type RelationshipKind
} from "@cuencada/types";
import { formatPersonDate } from "../../components/PersonDetailsSection";
import { lifeYears } from "../../lib/tree";

/** Field labels in the preview, in display order. */
export const MERGE_FIELD_LABELS: Record<PersonMergeField, string> = {
  fullName: "Nombre completo",
  nickname: "Apodo",
  familyBranch: "Rama",
  birthYear: "Año de nacimiento",
  birthDate: "Fecha de nacimiento",
  deathYear: "Año de fallecimiento",
  deathDate: "Fecha de fallecimiento",
  deceased: "Vive o falleció",
  birthplace: "Lugar de nacimiento",
  bio: "Biografía"
};

/** Shown for an empty value. */
export const EMPTY_VALUE = "Sin dato";

/**
 * A field value as text.
 *
 * @param field - Which field.
 * @param values - One side's values.
 */
export function formatMergeValue(field: PersonMergeField, values: PersonMergeValues): string {
  if (field === "deceased") return values.deceased ? "Falleció" : "Vive";
  const value = values[field];
  if (value === null || value === "") return EMPTY_VALUE;
  if (field === "birthDate" || field === "deathDate") return formatPersonDate(String(value));
  return String(value);
}

/** True when both sides hold the same value (nothing to choose). */
export function sameMergeValue(field: PersonMergeField, keep: PersonMergeValues, duplicate: PersonMergeValues): boolean {
  return keep[field] === duplicate[field];
}

const ROLE_LABELS: Record<MergeEdgeRole, string> = {
  parent: "madre o padre",
  child: "hija o hijo",
  partner: "pareja"
};

/**
 * "Rosa Ejemplo · madre o padre": a relationship as the preview lists it.
 *
 * @param edge - From the preview.
 */
export function describeMergeEdge(edge: PersonMergeEdge): string {
  return `${edge.otherPersonName ?? "Persona sin nombre"} · ${ROLE_LABELS[edge.role]}`;
}

/**
 * "Relación entre las dos personas (pareja)": a link between the two merged
 * people, dropped because it would join the person to themself.
 *
 * @param edge - From the preview (`outcome: "self"`).
 */
export function describeSelfEdge(edge: Pick<PersonMergeEdge, "kind">): string {
  return `Relación entre las dos personas (${kindName(edge.kind)})`;
}

/** Why a relationship cannot move, in Spanish. */
export const MERGE_CONFLICT_REASONS: Record<MergeConflictReason, string> = {
  cycle: "Crearía un ciclo: alguien quedaría como su propio antepasado.",
  too_many_parents: "Alguien quedaría con más de dos padres."
};

/** Why a merge is refused as is. */
export const MERGE_BLOCKER_TEXT: Partial<Record<FamilyIssueCode, string>> = {
  [FamilyIssueCode.MergeBothLinked]:
    "Las dos personas tienen su propia cuenta. No se pueden fusionar cuentas: desvincula una de ellas en «Datos» y vuelve a intentarlo.",
  [FamilyIssueCode.MergeConflict]:
    "Algunas relaciones no se pueden mover sin romper las reglas del árbol. Corrígelas primero (por ejemplo, quita la relación que sobra)."
};

/** "Relación de pareja" / "Padres e hijos" for a relationship kind. */
export function kindName(kind: RelationshipKind): string {
  return kind === "partner_of" ? "pareja" : "padres e hijos";
}

/** Why a pair is listed under "Posibles duplicados". */
export const DUPLICATE_REASON_LABELS: Record<DuplicateReason, string> = {
  same_name: "Mismo nombre",
  similar_name: "Nombre parecido",
  invite_fallback: "Invitación sin vincular"
};

/**
 * "n. 1990 · Rama Norte · con cuenta · 3 relaciones": what tells two people apart.
 *
 * @param person - One side of a pair.
 */
export function describeCandidate(person: DuplicateCandidate): string {
  const parts: string[] = [];
  const years = lifeYears(person);
  if (years !== null) parts.push(years);
  if (person.familyBranch !== null) parts.push(person.familyBranch);
  parts.push(person.linked ? "con cuenta" : "sin cuenta");
  parts.push(person.relationshipCount === 1 ? "1 relación" : `${person.relationshipCount} relaciones`);
  return parts.join(" · ");
}
