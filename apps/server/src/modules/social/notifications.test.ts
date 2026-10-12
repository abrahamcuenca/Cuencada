/**
 * WP-6.2 → notifications boundary [SEC]. `notify.ts` is WP-6.1's module (a
 * stub until it lands), so these tests mock it and check what the social
 * routes ask it to do: who is notified, by whom, for which photo; nothing
 * for people without accounts or self-actions; tag requests written off the
 * request path by the job (queued for every new tag); retraction on decline.
 */
import type { MediaTag } from "@cuencada/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestApp } from "../../../test/helpers/app.js";
import { type EventActor, eventActor } from "../../../test/helpers/events.js";
import { FakeStorage } from "../../../test/helpers/fakes.js";
import { insertPerson } from "../../../test/helpers/family.js";
import { createCuencada, insertMedia } from "../../../test/helpers/media.js";
import type { App } from "../../app.js";

const notify = vi.hoisted(() => ({
  recordNotification: vi.fn(async () => "00000000-0000-4000-8000-000000000001"),
  retractNotification: vi.fn(async () => undefined),
  markNotificationSeen: vi.fn(async () => undefined),
  pushNotifications: vi.fn(async () => undefined)
}));

vi.mock("../notifications/notify.js", () => notify);

let app: App;

beforeEach(async () => {
  vi.clearAllMocks();
  app = await createTestApp({ storage: new FakeStorage() });
});

afterEach(async () => {
  await app.jobs.onIdle();
  await app.close();
});

async function photoOf(uploader: EventActor, year: number): Promise<string> {
  const edition = await createCuencada({ year });
  return (await insertMedia({ cuencadaId: edition.id, uploadedByUserId: uploader.user.id })).id;
}

function call(actor: EventActor, method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: Record<string, unknown>) {
  return app.inject({ method, url, ...actor.auth, ...(payload === undefined ? {} : { payload }) });
}

describe("social notifications", () => {
  it("asks for a photo_tag_request to the tagged user from the job, and retracts it on decline", async () => {
    const uploader = await eventActor();
    const tagger = await eventActor();
    const tagged = await eventActor();
    const mediaId = await photoOf(uploader, 2041);
    const personId = (await insertPerson({ userId: tagged.user.id })).id;

    const response = await call(tagger, "POST", `/api/media/${mediaId}/tags`, { personId });
    expect(response.statusCode).toBe(201);
    await app.jobs.onIdle();
    expect(notify.recordNotification).toHaveBeenCalledTimes(1);
    expect(notify.recordNotification).toHaveBeenCalledWith(expect.anything(), {
      recipientUserId: tagged.user.id,
      actorUserId: tagger.user.id,
      kind: "photo_tag_request",
      target: { mediaId }
    });
    expect(notify.pushNotifications).toHaveBeenCalledTimes(1);

    const tag = response.json() as MediaTag; // validated by the route schema
    expect((await call(tagged, "DELETE", `/api/media/${mediaId}/tags/${tag.id}`)).statusCode).toBe(204);
    await app.jobs.onIdle();
    expect(notify.retractNotification).toHaveBeenCalledWith(expect.anything(), tagged.user.id, `tag:${mediaId}`);
  });

  it("marks the tag request seen when the tagged user approves", async () => {
    const uploader = await eventActor();
    const tagger = await eventActor();
    const tagged = await eventActor();
    const mediaId = await photoOf(uploader, 2045);
    const personId = (await insertPerson({ userId: tagged.user.id })).id;
    const tag = (await call(tagger, "POST", `/api/media/${mediaId}/tags`, { personId })).json() as MediaTag; // schema-validated
    expect((await call(tagged, "POST", `/api/media/tags/${tag.id}/approve`)).statusCode).toBe(200);
    expect(notify.markNotificationSeen).toHaveBeenCalledWith(expect.anything(), tagged.user.id, `tag:${mediaId}`);
    expect((await call(tagged, "POST", `/api/media/tags/${tag.id}/approve`)).statusCode).toBe(200);
    expect(notify.markNotificationSeen).toHaveBeenCalledTimes(1);
  });

  it("notifies nobody for people without accounts and self-tags", async () => {
    const uploader = await eventActor();
    const tagger = await eventActor();
    const mediaId = await photoOf(uploader, 2042);
    await call(tagger, "POST", `/api/media/${mediaId}/tags`, { personId: (await insertPerson()).id });
    await call(tagger, "POST", `/api/media/${mediaId}/tags`, { personId: (await insertPerson({ userId: tagger.user.id })).id });
    await app.jobs.onIdle();
    expect(notify.recordNotification).not.toHaveBeenCalled();
  });

  it("does not notify for a tag declined before the job ran", async () => {
    const uploader = await eventActor();
    const tagger = await eventActor();
    const tagged = await eventActor();
    const mediaId = await photoOf(uploader, 2043);
    const personId = (await insertPerson({ userId: tagged.user.id })).id;
    // Hold the queue so the decline commits first.
    let release: () => void = () => undefined;
    app.jobs.enqueue(
      "test.hold",
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        })
    );
    const tag = (await call(tagger, "POST", `/api/media/${mediaId}/tags`, { personId })).json() as MediaTag; // schema-validated
    expect((await call(tagged, "DELETE", `/api/media/${mediaId}/tags/${tag.id}`)).statusCode).toBe(204);
    release();
    await app.jobs.onIdle();
    expect(notify.recordNotification).not.toHaveBeenCalled();
  });

  it("notifies the uploader of new hearts and comments, never of their own or of an unlike", async () => {
    const uploader = await eventActor();
    const fan = await eventActor();
    const mediaId = await photoOf(uploader, 2044);

    await call(fan, "PUT", `/api/media/${mediaId}/like`);
    await call(fan, "PUT", `/api/media/${mediaId}/like`);
    await call(fan, "DELETE", `/api/media/${mediaId}/like`);
    await call(fan, "POST", `/api/media/${mediaId}/comments`, { body: "Bonita" });
    const calls = notify.recordNotification.mock.calls as unknown as Array<[unknown, { kind: string; recipientUserId: string; actorUserId: string }]>;
    expect(calls.map(([, input]) => [input.kind, input.recipientUserId, input.actorUserId])).toEqual([
      ["photo_liked", uploader.user.id, fan.user.id],
      ["photo_commented", uploader.user.id, fan.user.id]
    ]);
  });
});
