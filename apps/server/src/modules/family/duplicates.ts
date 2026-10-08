/**
 * "Posibles duplicados" (WP-4.5, admin-only): pairs of tree people that may
 * be the same human, for "Fusionar personas".
 *
 * - **Same name:** the normalized names are equal (case, accents, spaces
 *   and punctuation ignored), or equal except that one has one more trailing
 *   word (a second surname: "Lucía Ejemplo" / "Lucía Ejemplo Pérez"; the
 *   shorter name needs at least two words). Years must be compatible: birth
 *   years, and death years, differ by at most one when both are known.
 * - **Invite fallback:** an `invite.accepted` audit row with
 *   `personLink: "fallback"` named a tree person (`requestedPersonId`) but
 *   the account got a new person (`personId`); both still exist.
 *
 * The suggested person to keep is the requested tree person for a fallback,
 * else the one with more relationships (then the older one). Pairs where
 * both are linked to accounts are listed with `mergeable: false`. Computed in
 * memory over the whole tree (family scale: hundreds of people), sorted
 * deterministically and paged by offset. No account ids leave the server.
 */
import {
  type DuplicateCandidate,
  DuplicateReason,
  type PossibleDuplicate
} from "@cuencada/types";
import { and, count, eq, isNotNull, sql } from "drizzle-orm";
import { auditLogs, people, personRelationships } from "../../db/schema/index.js";
import type { DbOrTx } from "../../lib/audit.js";

/** Birth (or death) years further apart than this are not the same person. */
const YEAR_TOLERANCE = 1;

/**
 * Words of a name, compared loosely: lower case, accents stripped, anything
 * but letters and digits treated as a space.
 *
 * @param name - A full name.
 */
export function nameTokens(name: string): string[] {
  return name
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length > 0);
}

/**
 * How two token lists match: `same_name`, `similar_name` (one extra trailing
 * word, the shorter has ≥ 2), or `null`.
 */
export function nameMatch(a: readonly string[], b: readonly string[]): DuplicateReason | null {
  if (a.length === 0 || b.length === 0) return null;
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  if (!shorter.every((token, index) => token === longer[index])) return null;
  if (shorter.length === longer.length) return DuplicateReason.SameName;
  return longer.length - shorter.length === 1 && shorter.length >= 2 ? DuplicateReason.SimilarName : null;
}

/** Years that could belong to the same person (unknown is compatible). */
export function compatibleYears(
  a: { birthYear: number | null; deathYear: number | null },
  b: { birthYear: number | null; deathYear: number | null }
): boolean {
  const close = (x: number | null, y: number | null): boolean => x === null || y === null || Math.abs(x - y) <= YEAR_TOLERANCE;
  return close(a.birthYear, b.birthYear) && close(a.deathYear, b.deathYear);
}

interface PersonEntry extends DuplicateCandidate {
  tokens: string[];
  createdAt: Date;
}

const REASON_ORDER: Record<DuplicateReason, number> = {
  [DuplicateReason.InviteFallback]: 0,
  [DuplicateReason.SameName]: 1,
  [DuplicateReason.SimilarName]: 2
};

/** Keep the one with more relationships, then the older one, then the smaller id. */
function orient(a: PersonEntry, b: PersonEntry): [PersonEntry, PersonEntry] {
  if (a.relationshipCount !== b.relationshipCount) return a.relationshipCount > b.relationshipCount ? [a, b] : [b, a];
  if (a.createdAt.getTime() !== b.createdAt.getTime()) return a.createdAt < b.createdAt ? [a, b] : [b, a];
  return a.id < b.id ? [a, b] : [b, a];
}

function candidate(entry: PersonEntry): DuplicateCandidate {
  const { tokens: _tokens, createdAt: _createdAt, ...rest } = entry;
  return rest;
}

async function loadEntries(db: DbOrTx): Promise<Map<string, PersonEntry>> {
  const rows = await db
    .select({
      id: people.id,
      fullName: people.fullName,
      nickname: people.nickname,
      familyBranch: people.familyBranch,
      birthYear: people.birthYear,
      deathYear: people.deathYear,
      deceased: people.deceased,
      linked: sql<boolean>`${people.userId} is not null`,
      createdAt: people.createdAt
    })
    .from(people);
  const counts = new Map<string, number>();
  for (const column of [personRelationships.fromPersonId, personRelationships.toPersonId]) {
    const grouped = await db.select({ id: column, total: count() }).from(personRelationships).groupBy(column);
    for (const row of grouped) counts.set(row.id, (counts.get(row.id) ?? 0) + row.total);
  }
  return new Map(
    rows.map((row) => [row.id, { ...row, tokens: nameTokens(row.fullName), relationshipCount: counts.get(row.id) ?? 0 }])
  );
}

/** `(requestedPersonId, personId)` pairs of invite fallbacks whose people both still exist. */
async function fallbackPairs(db: DbOrTx, existing: ReadonlyMap<string, PersonEntry>): Promise<Array<[string, string]>> {
  const rows = await db
    .select({
      requested: sql<string | null>`${auditLogs.metadata} ->> 'requestedPersonId'`,
      created: sql<string | null>`${auditLogs.metadata} ->> 'personId'`
    })
    .from(auditLogs)
    .where(
      and(
        eq(auditLogs.action, "invite.accepted"),
        sql`${auditLogs.metadata} ->> 'personLink' = 'fallback'`,
        isNotNull(sql`${auditLogs.metadata} ->> 'requestedPersonId'`)
      )
    );
  const pairs: Array<[string, string]> = [];
  for (const row of rows) {
    if (row.requested === null || row.created === null || row.requested === row.created) continue;
    if (existing.has(row.requested) && existing.has(row.created)) pairs.push([row.requested, row.created]);
  }
  return pairs;
}

/**
 * Every possible-duplicate pair, sorted (invite fallbacks first, then same
 * name, then similar name; by name and ids).
 *
 * @param db - Client.
 */
export async function findPossibleDuplicates(db: DbOrTx): Promise<PossibleDuplicate[]> {
  const entries = await loadEntries(db);
  const found = new Map<string, { keep: PersonEntry; duplicate: PersonEntry; reason: DuplicateReason }>();
  const pairKey = (a: string, b: string): string => (a < b ? `${a}:${b}` : `${b}:${a}`);

  for (const [requested, created] of await fallbackPairs(db, entries)) {
    const keep = entries.get(requested);
    const duplicate = entries.get(created);
    if (keep !== undefined && duplicate !== undefined) found.set(pairKey(keep.id, duplicate.id), { keep, duplicate, reason: DuplicateReason.InviteFallback });
  }

  // Bucket by the first two words: a match (equal, or one extra trailing word) always shares them.
  const buckets = new Map<string, PersonEntry[]>();
  for (const entry of entries.values()) {
    if (entry.tokens.length === 0) continue;
    const key = entry.tokens.slice(0, 2).join(" ");
    const bucket = buckets.get(key);
    if (bucket === undefined) buckets.set(key, [entry]);
    else bucket.push(entry);
  }
  for (const bucket of buckets.values()) {
    for (let i = 0; i < bucket.length; i += 1) {
      for (let j = i + 1; j < bucket.length; j += 1) {
        const a = bucket[i];
        const b = bucket[j];
        if (a === undefined || b === undefined) continue;
        const key = pairKey(a.id, b.id);
        if (found.has(key)) continue;
        const reason = nameMatch(a.tokens, b.tokens);
        if (reason === null || !compatibleYears(a, b)) continue;
        const [keep, duplicate] = orient(a, b);
        found.set(key, { keep, duplicate, reason });
      }
    }
  }

  return [...found.values()]
    .sort(
      (x, y) =>
        REASON_ORDER[x.reason] - REASON_ORDER[y.reason] ||
        x.keep.tokens.join(" ").localeCompare(y.keep.tokens.join(" ")) ||
        x.keep.id.localeCompare(y.keep.id) ||
        x.duplicate.id.localeCompare(y.duplicate.id)
    )
    .map(({ keep, duplicate, reason }) => ({
      keep: candidate(keep),
      duplicate: candidate(duplicate),
      reason,
      mergeable: !(keep.linked && duplicate.linked)
    }));
}
