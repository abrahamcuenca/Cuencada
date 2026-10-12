/**
 * WP-6.4 × WP-6.2 [SEC]: photo tags through `mergePeopleTx` (the admin
 * merge route). Tags move to the kept person, a duplicate tag on the same
 * photo is deduped (approved wins over pending), a tag moved onto a person
 * linked to a different account returns to pending, and the call runs
 * before the account link moves. The merge audit counts moved and dropped
 * tags. Fictional people only.
 */
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestApp } from "../../../test/helpers/app.js";
import { insertCuencada } from "../../../test/helpers/cuencadas.js";
import { getTestDb } from "../../../test/helpers/db.js";
import { type AuthInjectOptions, createUser, loginAs, type TestUser } from "../../../test/helpers/factories.js";
import { insertPerson } from "../../../test/helpers/family.js";
import { insertMedia } from "../../../test/helpers/media.js";
import type { App } from "../../app.js";
import { auditLogs, mediaTags } from "../../db/schema/index.js";

let app: App;
let admin: TestUser;
let adminAuth: AuthInjectOptions;
let cuencadaId: string;

beforeEach(async () => {
  app = await createTestApp();
  admin = await createUser({ role: "admin", emailVerified: true });
  adminAuth = await loginAs(app, admin);
  cuencadaId = (await insertCuencada({ year: 2031 })).id;
});

afterEach(async () => {
  await app.close();
});

async function photo(): Promise<string> {
  return (await insertMedia({ cuencadaId })).id;
}

async function tag(mediaId: string, personId: string, status: "approved" | "pending", taggedByUserId: string | null = null): Promise<string> {
  const [row] = await getTestDb()
    .insert(mediaTags)
    .values({ mediaId, personId, status, approvedAt: status === "approved" ? new Date() : null, taggedByUserId })
    .returning({ id: mediaTags.id });
  if (row === undefined) throw new Error("no tag");
  return row.id;
}

async function tagRow(id: string) {
  const [row] = await getTestDb().select().from(mediaTags).where(eq(mediaTags.id, id));
  return row;
}

async function merge(keepId: string, duplicateId: string) {
  return app.inject({ method: "POST", url: `/api/admin/people/${keepId}/merge`, payload: { duplicateId }, ...adminAuth });
}

async function mergeAudit(keepId: string): Promise<Record<string, unknown> | undefined> {
  const [row] = await getTestDb()
    .select({ metadata: auditLogs.metadata })
    .from(auditLogs)
    .where(and(eq(auditLogs.action, "person.merged"), eq(auditLogs.entityId, keepId)));
  return row?.metadata ?? undefined;
}

describe("mergePeopleTx with photo tags", () => {
  it("moves an approved tag, dedupes a photo tagged twice (approved wins) and counts both in the audit", async () => {
    const keep = await insertPerson({ fullName: "Abuela Rosa Muestra" });
    const duplicate = await insertPerson({ fullName: "Abuela Rosa Muestra" });
    const [p1, p2, p3] = [await photo(), await photo(), await photo()];
    const moved = await tag(p1, duplicate.id, "approved");
    // Photo 2: keep's tag is pending, the duplicate's approved → the duplicate's moves, keep's is dropped.
    const keepPending = await tag(p2, keep.id, "pending");
    const dupApproved = await tag(p2, duplicate.id, "approved");
    // Photo 3: keep's tag is approved, the duplicate's pending → the duplicate's is dropped.
    const keepApproved = await tag(p3, keep.id, "approved");
    const dupPending = await tag(p3, duplicate.id, "pending");

    const response = await merge(keep.id, duplicate.id);
    expect(response.statusCode, response.body).toBe(200);
    expect(await tagRow(moved)).toMatchObject({ personId: keep.id, status: "approved" });
    expect(await tagRow(dupApproved)).toMatchObject({ personId: keep.id, status: "approved" });
    expect(await tagRow(keepPending)).toBeUndefined();
    expect(await tagRow(keepApproved)).toMatchObject({ personId: keep.id, status: "approved" });
    expect(await tagRow(dupPending)).toBeUndefined();
    // One tag of keep per photo, none left on the deleted duplicate.
    const all = await getTestDb().select().from(mediaTags);
    expect(all.map((row) => [row.mediaId, row.personId]).sort()).toEqual([
      [p1, keep.id],
      [p2, keep.id],
      [p3, keep.id]
    ].sort());
    expect(await mergeAudit(keep.id)).toMatchObject({ tagsMoved: 2, tagsDropped: 2 });
  });

  it("returns a moved tag to pending when keep is linked to a different account (unless that user tagged it)", async () => {
    const owner = await createUser({ emailVerified: true });
    const keep = await insertPerson({ fullName: "Ana Morales Vega", userId: owner.id });
    const duplicate = await insertPerson({ fullName: "Ana Morales Vega" });
    const [p1, p2] = [await photo(), await photo()];
    const byOther = await tag(p1, duplicate.id, "approved", admin.id);
    const byOwner = await tag(p2, duplicate.id, "approved", owner.id);

    expect((await merge(keep.id, duplicate.id)).statusCode).toBe(200);
    expect(await tagRow(byOther)).toMatchObject({ personId: keep.id, status: "pending", approvedAt: null });
    expect(await tagRow(byOwner)).toMatchObject({ personId: keep.id, status: "approved" });
    expect(await mergeAudit(keep.id)).toMatchObject({ tagsMoved: 2, tagsDropped: 0 });
  });

  it("keeps approved tags approved when the duplicate's own account link moves to keep (tags move first)", async () => {
    const owner = await createUser({ emailVerified: true });
    const keep = await insertPerson({ fullName: "Luis Ficticio Paz" });
    const duplicate = await insertPerson({ fullName: "Luis Ficticio Paz", userId: owner.id });
    const approved = await tag(await photo(), duplicate.id, "approved", admin.id);

    expect((await merge(keep.id, duplicate.id)).statusCode).toBe(200);
    expect(await tagRow(approved)).toMatchObject({ personId: keep.id, status: "approved" });
  });
});
