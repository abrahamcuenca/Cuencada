/**
 * WP-6.4: resolving a proposal notifies each proposer through WP-6.1's
 * `notify.ts` (inside the resolve transaction; pushed after the commit),
 * never the resolving admin, and never with the note. `notify.ts` is a
 * WP-6.0 stub until WP-6.1 lands, so this file observes the calls; once 6.1
 * is in, the `notifications` rows can be asserted instead.
 */
import { randomUUID } from "node:crypto";
import type { TreeLinkProposal } from "@cuencada/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestApp } from "../../../test/helpers/app.js";
import { type AuthInjectOptions, createUser, loginAs, type TestUser } from "../../../test/helpers/factories.js";
import { insertPerson } from "../../../test/helpers/family.js";
import type { App } from "../../app.js";

const notify = vi.hoisted(() => ({
  recordNotification: vi.fn<(tx: unknown, input: unknown) => Promise<string | null>>(),
  pushNotifications: vi.fn<(app: unknown, ids: readonly string[]) => Promise<void>>()
}));

vi.mock("../notifications/notify.js", () => ({
  recordNotification: notify.recordNotification,
  retractNotification: vi.fn(async () => undefined),
  pushNotifications: notify.pushNotifications
}));

let app: App;
let admin: TestUser;
let adminAuth: AuthInjectOptions;
let member: TestUser;
let memberAuth: AuthInjectOptions;

beforeEach(async () => {
  notify.recordNotification.mockReset().mockImplementation(async () => randomUUID());
  notify.pushNotifications.mockReset().mockResolvedValue(undefined);
  app = await createTestApp();
  admin = await createUser({ role: "admin", emailVerified: true });
  adminAuth = await loginAs(app, admin);
  member = await createUser({ emailVerified: true });
  memberAuth = await loginAs(app, member);
});

afterEach(async () => {
  await app.close();
});

describe("proposal resolution notifications", () => {
  it("records tree_proposal_resolved for the proposer (no note) and pushes it after the commit", async () => {
    const a = await insertPerson();
    const b = await insertPerson();
    const created = await app.inject({ method: "POST", url: "/api/family/proposals", payload: { kind: "same_person", fromPersonId: a.id, toPersonId: b.id }, ...memberAuth });
    const proposal = created.json<TreeLinkProposal>();
    const response = await app.inject({
      method: "POST",
      url: `/api/admin/family/proposals/${proposal.id}/resolve`,
      payload: { decision: "reject", note: "Nota solo para quien propuso" },
      ...adminAuth
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(notify.recordNotification).toHaveBeenCalledTimes(1);
    const [, input] = notify.recordNotification.mock.calls[0] ?? [];
    expect(input).toEqual({ recipientUserId: member.id, actorUserId: admin.id, kind: "tree_proposal_resolved", target: { proposalId: proposal.id } });
    expect(JSON.stringify(input)).not.toContain("Nota");
    const returned = await notify.recordNotification.mock.results[0]?.value;
    expect(notify.pushNotifications).toHaveBeenCalledWith(expect.anything(), [returned]);
  });

  it("does not notify the admin who proposed and resolved", async () => {
    const a = await insertPerson();
    const b = await insertPerson();
    const created = await app.inject({ method: "POST", url: "/api/family/proposals", payload: { kind: "same_person", fromPersonId: a.id, toPersonId: b.id }, ...adminAuth });
    const response = await app.inject({
      method: "POST",
      url: `/api/admin/family/proposals/${created.json<TreeLinkProposal>().id}/resolve`,
      payload: { decision: "reject" },
      ...adminAuth
    });
    expect(response.statusCode).toBe(200);
    expect(notify.recordNotification).not.toHaveBeenCalled();
    expect(notify.pushNotifications).toHaveBeenCalledWith(expect.anything(), []);
  });

  it("pushes nothing when the resolve rolls back (merge conflict)", async () => {
    const a = await insertPerson({ userId: member.id });
    const other = await createUser({ emailVerified: true });
    const b = await insertPerson({ userId: other.id });
    const created = await app.inject({ method: "POST", url: "/api/family/proposals", payload: { kind: "same_person", fromPersonId: a.id, toPersonId: b.id }, ...memberAuth });
    const response = await app.inject({
      method: "POST",
      url: `/api/admin/family/proposals/${created.json<TreeLinkProposal>().id}/resolve`,
      payload: { decision: "approve" },
      ...adminAuth
    });
    expect(response.statusCode).toBe(409);
    expect(notify.pushNotifications).not.toHaveBeenCalled();
  });
});
