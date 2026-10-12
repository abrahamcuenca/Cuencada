/**
 * WP-6.4 test fixtures: MSW handlers for the one-tree endpoints over the
 * same in-memory {@link FamilyDb} (extended bands, "Árbol completo", root
 * setting, proposals and the branches report). Fictional people only.
 * GETs are not recorded in `db.log`, so the older tests' request logs stay as they were.
 */
import type {
  ApiError,
  DisconnectedBranchReport,
  FamilySettings,
  PersonSummary,
  TreeLinkProposal,
  TreeLinkProposalGroup,
  TreeOverviewNode
} from "@cuencada/types";
import { type HttpHandler, HttpResponse, http } from "msw";
import { apiUrl, errorBody } from "../../../../test/auth";
import { type FamilyDb, fixtureId, toSummary } from "./fixtures";

/** One-tree state kept beside the family graph (all optional, so older fixtures still type-check). */
export interface OneTreeState {
  rootId?: string | null;
  proposals?: TreeLinkProposal[];
  branches?: DisconnectedBranchReport;
  /** Answer the next resolve with this error (e.g. a merge conflict). */
  resolveError?: { status: number; body: ApiError } | null;
  /** `viewerConnected` override for the overview (default: computed from the root's component). */
  viewerConnected?: boolean | null;
}

/** The db the handlers accept: the family graph plus the one-tree state. */
export type OneTreeDb = FamilyDb & OneTreeState;

let proposalSeq = 800;

/** A fictional proposal by the caller. */
export function makeProposal(db: FamilyDb, overrides: Partial<TreeLinkProposal> & Pick<TreeLinkProposal, "kind">): TreeLinkProposal {
  proposalSeq += 1;
  return {
    id: fixtureId(proposalSeq),
    from: null,
    to: null,
    relation: null,
    note: null,
    status: "pending",
    proposedByName: "José Herrera Navarro",
    isMine: true,
    resolvedByName: null,
    resolvedAt: null,
    resolutionNote: null,
    createdAt: "2026-10-05T15:00:00.000Z",
    ...overrides
  };
}

function parents(db: FamilyDb, id: string): string[] {
  return db.relationships.filter((r) => r.kind === "parent_of" && r.toPersonId === id).map((r) => r.fromPersonId);
}

function children(db: FamilyDb, id: string): string[] {
  return db.relationships.filter((r) => r.kind === "parent_of" && r.fromPersonId === id).map((r) => r.toPersonId);
}

function partners(db: FamilyDb, id: string): string[] {
  return db.relationships
    .filter((r) => r.kind === "partner_of" && (r.fromPersonId === id || r.toPersonId === id))
    .map((r) => (r.fromPersonId === id ? r.toPersonId : r.fromPersonId));
}

const unique = (ids: string[]): string[] => [...new Set(ids)];

function summariesOf(db: FamilyDb, ids: string[]): PersonSummary[] {
  return ids.flatMap((id) => {
    const person = db.people.get(id);
    return person === undefined ? [] : [toSummary(person)];
  });
}

/** Same rules as the server's `extendedBandIds`. */
export function fixtureBands(db: FamilyDb, focusId: string): { tios: string[]; primos: string[]; tiosAbuelos: string[] } {
  const ps = parents(db, focusId);
  const gps = unique(ps.flatMap((id) => parents(db, id)));
  const ggps = unique(gps.flatMap((id) => parents(db, id)));
  const siblings = unique(ps.flatMap((id) => children(db, id)));
  const taken = new Set([focusId, ...ps, ...gps, ...ggps, ...siblings]);
  const fresh = (ids: string[]): string[] => {
    const out = unique(ids).filter((id) => !taken.has(id));
    for (const id of out) taken.add(id);
    return out;
  };
  const blood = fresh(gps.flatMap((id) => children(db, id)));
  const inLaws = fresh(blood.flatMap((id) => partners(db, id)));
  const primos = fresh(blood.flatMap((id) => children(db, id)));
  const tiosAbuelos = fresh(ggps.flatMap((id) => children(db, id)));
  return { tios: [...blood, ...inLaws], primos, tiosAbuelos };
}

function outlineChildren(db: FamilyDb, id: string): string[] {
  const ps = partners(db, id);
  return unique([...children(db, id), ...ps.flatMap((partner) => children(db, partner))]).filter((child) => child !== id && !ps.includes(child));
}

function overviewNode(db: FamilyDb, id: string, parentId: string | null, included: Set<string>): TreeOverviewNode | null {
  const person = db.people.get(id);
  if (person === undefined) return null;
  const kids = outlineChildren(db, id);
  return {
    id,
    parentId,
    name: person.fullName,
    nickname: person.nickname,
    birthYear: person.birthYear,
    deathYear: person.deceased ? person.deathYear : null,
    deceased: person.deceased,
    partners: partners(db, id).flatMap((partner) => {
      const p = db.people.get(partner);
      return p === undefined ? [] : [{ id: partner, name: p.fullName }];
    }),
    childrenCount: kids.length,
    hasMore: kids.some((kid) => !included.has(kid))
  };
}

/** The outline from `startId`, `depth` generations (BFS, a person shown once). */
export function fixtureOverview(db: FamilyDb, startId: string, depth: number): TreeOverviewNode[] {
  const entries: Array<{ id: string; parentId: string | null }> = [{ id: startId, parentId: null }];
  const seen = new Set([startId]);
  let frontier = [startId];
  for (let level = 1; level <= depth; level += 1) {
    const next: string[] = [];
    for (const parentId of frontier) {
      for (const child of outlineChildren(db, parentId)) {
        if (seen.has(child)) continue;
        seen.add(child);
        entries.push({ id: child, parentId });
        next.push(child);
      }
    }
    frontier = next;
  }
  return entries.flatMap((entry) => overviewNode(db, entry.id, entry.parentId, seen) ?? []);
}

function componentOf(db: FamilyDb, start: string): Set<string> {
  const seen = new Set([start]);
  const queue = [start];
  while (queue.length > 0) {
    const id = queue.shift() ?? "";
    for (const next of [...parents(db, id), ...children(db, id), ...partners(db, id)]) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return seen;
}

function pathTo(db: FamilyDb, rootId: string, targetId: string): string[] {
  const previous = new Map<string, string>();
  const seen = new Set([rootId]);
  const queue = [rootId];
  while (queue.length > 0) {
    const id = queue.shift() ?? "";
    if (id === targetId) break;
    for (const child of outlineChildren(db, id)) {
      if (seen.has(child)) continue;
      seen.add(child);
      previous.set(child, id);
      queue.push(child);
    }
  }
  if (!seen.has(targetId)) return [];
  const path = [targetId];
  let cursor = targetId;
  while (cursor !== rootId) {
    const parent = previous.get(cursor);
    if (parent === undefined) return [];
    path.unshift(parent);
    cursor = parent;
  }
  return path;
}

function groupsOf(proposals: TreeLinkProposal[], pendingOnly: boolean): TreeLinkProposalGroup[] {
  const groups = new Map<string, TreeLinkProposal[]>();
  for (const proposal of proposals) {
    if (pendingOnly && proposal.status !== "pending") continue;
    const ids = [proposal.from?.id ?? proposal.id, proposal.to?.id ?? proposal.id].sort();
    const key = ids.join(":");
    groups.set(key, [...(groups.get(key) ?? []), proposal]);
  }
  return [...groups].map(([pairKey, list]) => ({ pairKey, proposals: list }));
}

async function bodyOf(request: Request, db: FamilyDb): Promise<Record<string, unknown>> {
  const text = await request.text();
  const body: unknown = text ? JSON.parse(text) : {};
  const url = new URL(request.url);
  db.log.push({ method: request.method, path: url.pathname.replace(/^.*\/api/, ""), search: url.search, body });
  return typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {}; // JSON object bodies only in these tests
}

/**
 * MSW handlers for the WP-6.4 endpoints over `db`.
 *
 * @param mePersonId - The caller's own person (default focus, `viewerConnected`).
 */
export function oneTreeHandlers(db: OneTreeDb, mePersonId: string | null): HttpHandler[] {
  const notFound = (): Response => HttpResponse.json(errorBody("NOT_FOUND", "No encontramos a esa persona."), { status: 404 });
  const settings = (): FamilySettings => {
    const root = db.rootId ? db.people.get(db.rootId) : undefined;
    return { root: root === undefined ? null : toSummary(root), updatedAt: root === undefined ? null : "2026-10-01T00:00:00.000Z" };
  };
  return [
    http.get(apiUrl("/family/tree/extended"), ({ request }) => {
      const personId = new URL(request.url).searchParams.get("personId") ?? mePersonId;
      if (personId === null || !db.people.has(personId)) return notFound();
      const bands = fixtureBands(db, personId);
      return HttpResponse.json({
        focusId: personId,
        tios: summariesOf(db, bands.tios),
        primos: summariesOf(db, bands.primos),
        tiosAbuelos: summariesOf(db, bands.tiosAbuelos),
        truncated: false
      });
    }),
    http.get(apiUrl("/family/overview"), ({ request }) => {
      const url = new URL(request.url);
      const rootId = db.rootId ?? null;
      const viewerConnected =
        db.viewerConnected !== undefined ? db.viewerConnected : rootId === null || mePersonId === null ? null : componentOf(db, rootId).has(mePersonId);
      const start = url.searchParams.get("personId") ?? rootId;
      if (start === null) return HttpResponse.json({ rootId: null, nodes: [], viewerConnected });
      if (!db.people.has(start)) return notFound();
      return HttpResponse.json({ rootId, nodes: fixtureOverview(db, start, Number(url.searchParams.get("depth") ?? "2")), viewerConnected });
    }),
    http.get(apiUrl("/family/overview/path"), ({ request }) => {
      const personId = new URL(request.url).searchParams.get("personId") ?? "";
      return HttpResponse.json({ ids: db.rootId ? pathTo(db, db.rootId, personId) : [] });
    }),
    http.get(apiUrl("/family/settings"), () => HttpResponse.json(settings())),
    http.get(apiUrl("/admin/family/settings"), () => HttpResponse.json(settings())),
    http.put(apiUrl("/admin/family/settings"), async ({ request }) => {
      const body = await bodyOf(request, db);
      db.rootId = typeof body.rootPersonId === "string" ? body.rootPersonId : null;
      return HttpResponse.json(settings());
    }),
    http.get(apiUrl("/family/proposals"), () => HttpResponse.json({ items: (db.proposals ?? []).filter((p) => p.isMine), nextCursor: null })),
    http.post(apiUrl("/family/proposals"), async ({ request }) => {
      const body = await bodyOf(request, db);
      const from = db.people.get(String(body.fromPersonId));
      const to = db.people.get(String(body.toPersonId));
      if (from === undefined || to === undefined) return notFound();
      const proposal = makeProposal(db, {
        kind: body.kind === "relate" ? "relate" : "same_person",
        from: toSummary(from),
        to: toSummary(to),
        relation: body.relation === "parent_of" || body.relation === "partner_of" ? body.relation : null,
        note: typeof body.note === "string" ? body.note : null
      });
      db.proposals = [proposal, ...(db.proposals ?? [])];
      return HttpResponse.json(proposal, { status: 201 });
    }),
    http.delete(apiUrl("/family/proposals/:id"), async ({ request, params }) => {
      await bodyOf(request, db);
      const proposal = db.proposals?.find((p) => p.id === String(params.id) && p.isMine);
      if (proposal === undefined) return HttpResponse.json(errorBody("NOT_FOUND", "No encontramos esa propuesta."), { status: 404 });
      proposal.status = "withdrawn";
      return new HttpResponse(null, { status: 204 });
    }),
    http.get(apiUrl("/admin/family/proposals"), ({ request }) => {
      const pendingOnly = new URL(request.url).searchParams.get("status") === "pending";
      return HttpResponse.json({ items: groupsOf(db.proposals ?? [], pendingOnly), nextCursor: null });
    }),
    http.post(apiUrl("/admin/family/proposals/:id/resolve"), async ({ request, params }) => {
      const body = await bodyOf(request, db);
      if (db.resolveError) {
        const { status, body: errorResponse } = db.resolveError;
        return HttpResponse.json(errorResponse, { status });
      }
      const proposal = db.proposals?.find((p) => p.id === String(params.id));
      if (proposal === undefined) return HttpResponse.json(errorBody("NOT_FOUND", "No encontramos esa propuesta."), { status: 404 });
      proposal.status = body.decision === "approve" ? "approved" : "rejected";
      proposal.resolutionNote = typeof body.note === "string" ? body.note : null;
      return HttpResponse.json(proposal);
    }),
    http.get(apiUrl("/admin/family/branches"), () =>
      HttpResponse.json(db.branches ?? { rootPersonId: db.rootId ?? null, items: [], nextCursor: null })
    )
  ];
}
