/**
 * Pure state helpers for the admin attendance checklist.
 */
import type { AttendanceRecord, PersonSummary } from "@cuencada/types";

/** Unsaved checklist edits, relative to the saved attendance. */
export interface AttendanceChanges {
  add: ReadonlySet<string>;
  remove: ReadonlySet<string>;
}

/** One checkbox row. */
export interface ChecklistRow {
  personId: string;
  label: string;
  hint: string | undefined;
}

/**
 * Applies a checkbox change.
 *
 * @param changes - Current unsaved edits.
 * @param personId - The person toggled.
 * @param checked - The new checkbox state.
 * @param recorded - Whether the person is in the saved attendance.
 * @returns New edits; toggling back to the saved state drops the edit.
 */
export function toggleAttendance(changes: AttendanceChanges, personId: string, checked: boolean, recorded: boolean): AttendanceChanges {
  const add = new Set(changes.add);
  const remove = new Set(changes.remove);
  if (recorded) {
    if (checked) remove.delete(personId);
    else remove.add(personId);
  } else if (checked) {
    add.add(personId);
  } else {
    add.delete(personId);
  }
  return { add, remove };
}

/**
 * @param changes - Unsaved edits.
 * @returns The bulk request body lists, sorted for stable requests.
 */
export function attendanceChanges(changes: AttendanceChanges): { add: string[]; remove: string[] } {
  return { add: [...changes.add].sort(), remove: [...changes.remove].sort() };
}

/** Lower-case, accent-free text for searching Spanish names. */
export function normalizeName(value: string): string {
  return value.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase("es-MX").trim();
}

/**
 * @param name - A display name.
 * @param query - The search box text (empty matches everything).
 * @returns Whether the name contains the query, ignoring case and accents.
 */
export function matchesSearch(name: string, query: string): boolean {
  const needle = normalizeName(query);
  return needle === "" || normalizeName(name).includes(needle);
}

/**
 * Rows to show: saved attendees first (so they can be removed even if the
 * people search doesn't return them), then the other people from the search.
 *
 * @param records - Saved attendance, already filtered by the search.
 * @param people - The current page of family people.
 * @returns De-duplicated rows.
 */
export function checklistRows(records: readonly AttendanceRecord[], people: readonly PersonSummary[]): ChecklistRow[] {
  const seen = new Set<string>();
  const rows: ChecklistRow[] = [];
  const sortedRecords = [...records].sort((a, b) => a.displayName.localeCompare(b.displayName, "es-MX"));
  for (const record of sortedRecords) {
    seen.add(record.personId);
    rows.push({ personId: record.personId, label: record.displayName, hint: "Registrado como asistente" });
  }
  for (const person of people) {
    if (seen.has(person.id)) continue;
    seen.add(person.id);
    rows.push({ personId: person.id, label: person.fullName, hint: person.nickname ? `«${person.nickname}»` : undefined });
  }
  return rows;
}
