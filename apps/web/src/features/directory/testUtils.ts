/**
 * Test fixtures and MSW handlers for the directory (tests only). Entries are
 * built with the contract's `toDirectoryEntry`, so hidden fields are absent.
 */
import { type DirectoryEntry, directoryEntrySchema, directoryQuerySchema, errorHttpStatus, toDirectoryEntry } from "@cuencada/types";
import { HttpResponse, http, type HttpHandler } from "msw";
import { apiUrl, errorBody } from "../../../test/auth";

/** A stable UUID for test member `n`. */
export function memberId(n: number): string {
  return `7a000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

/** Contact data of a test member; `null` = not shared. */
export interface MemberContact {
  email?: string | null;
  phone?: string | null;
  city?: string | null;
}

/**
 * @param n - Member number.
 * @param overrides - Name, branch, bio and the shared contact fields.
 * @returns A `DirectoryEntry` as the server would serialize it.
 */
export function makeEntry(n: number, overrides: Partial<Pick<DirectoryEntry, "fullName" | "displayName" | "familyBranch" | "bio" | "personId" | "avatarUrl">> & MemberContact = {}): DirectoryEntry {
  const { email = null, phone = null, city = null, ...rest } = overrides;
  return directoryEntrySchema.parse(
    toDirectoryEntry({
      userId: memberId(n),
      personId: null,
      displayName: `Primo ${n}`,
      fullName: `Primo ${n} Ejemplo`,
      familyBranch: "Rama Norte",
      avatarUrl: null,
      bio: null,
      ...rest,
      email,
      phone,
      city,
      visibility: { showEmail: email !== null, showPhone: phone !== null, showCity: city !== null }
    })
  );
}

/** Mutable state behind {@link directoryHandlers}. */
export interface FakeDirectoryDb {
  entries: DirectoryEntry[];
  /** Every list request as its query string, e.g. `q=Ros&limit=30`. */
  log: string[];
  /** Status the list answers with (200 by default). */
  listError: "FORBIDDEN" | "INTERNAL" | null;
}

/** A fresh fake database. */
export function makeDirectoryDb(entries: DirectoryEntry[] = []): FakeDirectoryDb {
  return { entries, log: [], listError: null };
}

/**
 * Handlers for `GET /directory` (cursor = index of the next item, `q` on the
 * names, `familyBranch` exact, `city` on visible cities) and `GET /directory/:id`.
 *
 * @param db - The fake database.
 * @returns MSW handlers.
 */
export function directoryHandlers(db: FakeDirectoryDb): HttpHandler[] {
  return [
    http.get(apiUrl("/directory"), ({ request }) => {
      const url = new URL(request.url);
      db.log.push(url.searchParams.toString());
      if (db.listError !== null) return HttpResponse.json(errorBody(db.listError), { status: errorHttpStatus[db.listError] });
      const parsed = directoryQuerySchema.safeParse(Object.fromEntries(url.searchParams));
      if (!parsed.success) return HttpResponse.json(errorBody("VALIDATION"), { status: 400 });
      const { q, familyBranch, cursor, limit } = parsed.data;
      // `city` is in T5-BE's query schema (visible cities only, case-insensitive here).
      const city = url.searchParams.get("city")?.toLocaleLowerCase("es-MX");
      const needle = q?.toLocaleLowerCase("es-MX");
      const matches = db.entries.filter(
        (entry) =>
          (needle === undefined || `${entry.fullName} ${entry.displayName}`.toLocaleLowerCase("es-MX").includes(needle)) &&
          (familyBranch === undefined || entry.familyBranch === familyBranch) &&
          (city === undefined || entry.city?.toLocaleLowerCase("es-MX") === city)
      );
      const start = cursor === undefined ? 0 : Number(cursor);
      const items = matches.slice(start, start + limit);
      const next = start + limit < matches.length ? String(start + limit) : null;
      return HttpResponse.json({ items, nextCursor: next });
    }),
    http.get(apiUrl("/directory/:id"), ({ params }) => {
      if (db.listError !== null) return HttpResponse.json(errorBody(db.listError), { status: errorHttpStatus[db.listError] });
      const entry = db.entries.find((candidate) => candidate.userId === params.id);
      if (!entry) return HttpResponse.json(errorBody("NOT_FOUND"), { status: 404 });
      return HttpResponse.json(entry);
    })
  ];
}
