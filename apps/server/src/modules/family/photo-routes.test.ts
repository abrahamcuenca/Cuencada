/**
 * WP-4.3 tree photos [SEC]: the upload/confirm/delete routes, who may change
 * a photo (`canEditPersonPhoto`, qualifying edges), the crop clamp, the
 * resolver precedence and the tree/detail read paths.
 */
import type { FamilyTreeView, PersonDetails, PersonPhotoUploadResponse } from "@cuencada/types";
import { eq } from "drizzle-orm";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestApp } from "../../../test/helpers/app.js";
import { type MutableClock, mutableClock } from "../../../test/helpers/cuencadas.js";
import { getTestDb } from "../../../test/helpers/db.js";
import {
  type AuthInjectOptions,
  bearerFor,
  createSession,
  createUser,
  type CreateUserOptions,
  type TestUser
} from "../../../test/helpers/factories.js";
import { FakeStorage } from "../../../test/helpers/fakes.js";
import { insertParentOf, insertPartnerOf, insertPerson } from "../../../test/helpers/family.js";
import type { App } from "../../app.js";
import { auditLogs, people, personPhotoUploads, personRelationships, personRevisions, profiles } from "../../db/schema/index.js";
import { avatarKeys } from "../profile/avatar.js";
import {
  PersonPhotoSize,
  deletePersonPhotoObjects,
  personPhotoDerivativeKeys,
  personPhotoKeys,
  personPhotoObjectKeys,
  resolvePersonPhoto
} from "./personPhoto.js";
import { isCloseRelative } from "./photoAccess.js";

let app: App;
let storage: FakeStorage;
let clock: MutableClock;
let logs: string[];

beforeEach(async () => {
  storage = new FakeStorage();
  clock = mutableClock(new Date().toISOString());
  logs = [];
  app = await createTestApp({ storage, clock, logStream: { write: (line) => logs.push(line) } });
});

afterEach(async () => {
  await app.close();
});

interface Actor {
  user: TestUser;
  auth: AuthInjectOptions;
}

async function actor(options: CreateUserOptions = {}): Promise<Actor> {
  const user = await createUser({ emailVerified: true, ...options });
  return { user, auth: await bearerFor(user, await createSession(user.id)) };
}

function errorOf(body: string): { code: string; detailCode: string | undefined } {
  const parsed = JSON.parse(body) as { error?: { code?: string; details?: Array<{ code?: string }> } }; // test-only shape probe
  return { code: parsed.error?.code ?? "", detailCode: parsed.error?.details?.[0]?.code };
}

/** Portrait once oriented (EXIF 6): 100 wide × 200 tall, red on top, blue below. */
async function orientedJpeg(): Promise<Buffer> {
  const half = (color: string): Promise<Buffer> =>
    sharp({ create: { width: 100, height: 100, channels: 3, background: color } }).png().toBuffer();
  return sharp({ create: { width: 200, height: 100, channels: 3, background: "#000" } })
    .composite([
      { input: await half("#ff0000"), left: 0, top: 0 },
      { input: await half("#0000ff"), left: 100, top: 0 }
    ])
    .withMetadata({ orientation: 6 })
    .withExif({ IFD0: { Make: "SecretCam" }, IFD3: { GPSLatitudeRef: "N", GPSLatitude: "20/1 58/1 0/1" } })
    .jpeg({ quality: 95 })
    .toBuffer();
}

async function intent(auth: AuthInjectOptions, personId: string, byteSize: number, mimeType = "image/jpeg") {
  return app.inject({ method: "POST", url: `/api/family/people/${personId}/photo/uploads`, ...auth, payload: { mimeType, byteSize } });
}

async function objectKeyOf(uploadId: string): Promise<string> {
  const [row] = await getTestDb().select().from(personPhotoUploads).where(eq(personPhotoUploads.id, uploadId));
  if (row === undefined) throw new Error("no upload row");
  return row.objectKey;
}

function confirm(auth: AuthInjectOptions, personId: string, uploadId: string, payload: unknown = {}) {
  return app.inject({
    method: "POST",
    url: `/api/family/people/${personId}/photo/uploads/${uploadId}/confirm`,
    ...auth,
    payload
  });
}

/** Intent → simulated browser PUT → confirm. */
async function uploadPhoto(auth: AuthInjectOptions, personId: string, body: Buffer, crop?: unknown) {
  const created = await intent(auth, personId, body.byteLength);
  expect(created.statusCode).toBe(201);
  const upload = created.json<PersonPhotoUploadResponse>();
  await storage.simulateUpload(await objectKeyOf(upload.uploadId), body, "image/jpeg");
  const confirmed = await confirm(auth, personId, upload.uploadId, crop === undefined ? {} : { crop });
  return { upload, confirmed };
}

function stored(key: string): Uint8Array {
  const object = storage.objects.get(key);
  if (object === undefined) throw new Error(`missing object ${key}`);
  return object.body;
}

async function pixelAt(key: string, x: number, y: number): Promise<{ r: number; b: number }> {
  const { data, info } = await sharp(stored(key)).raw().toBuffer({ resolveWithObject: true });
  const offset = (y * info.width + x) * info.channels;
  return { r: data[offset] ?? 0, b: data[offset + 2] ?? 0 };
}

/** A member linked to their own person. */
async function linkedMember(options: CreateUserOptions = {}): Promise<Actor & { personId: string }> {
  const member = await actor(options);
  const person = await insertPerson({ userId: member.user.id, fullName: "Miembro Vinculado" });
  return { ...member, personId: person.id };
}

describe("POST /api/family/people/:id/photo/uploads → confirm (admin)", () => {
  it("crops after auto-orient, writes 512/256/64 WebPs without metadata, records a keyless revision", async () => {
    const admin = await actor({ role: "admin" });
    const ancestor = await insertPerson({ fullName: "Bisabuela Ficticia", deceased: true, birthYear: 1890, deathYear: 1960 });
    const puts = vi.spyOn(storage, "put");

    const { upload, confirmed } = await uploadPhoto(admin.auth, ancestor.id, await orientedJpeg(), { x: 0, y: 100, size: 100 });

    expect(confirmed.statusCode).toBe(200);
    const details = confirmed.json<PersonDetails>();
    expect(details).toMatchObject({ id: ancestor.id, photoSource: "person", canEditPhoto: true });
    expect(details.photoUrl).toContain(`${upload.uploadId}-512.webp`);
    expect(details.avatarUrl).toContain(`${upload.uploadId}-256.webp`);

    const keys = personPhotoKeys(ancestor.id, upload.uploadId, "image/jpeg");
    expect(storage.objects.has(keys.original)).toBe(false);
    for (const [key, size] of [
      [keys.display, 512],
      [keys.large, 256],
      [keys.small, 64]
    ] as const) {
      const metadata = await sharp(stored(key)).metadata();
      expect(metadata).toMatchObject({ format: "webp", width: size, height: size });
      expect(metadata.exif).toBeUndefined();
      expect(metadata.orientation).toBeUndefined();
      expect(Buffer.from(stored(key)).includes("SecretCam")).toBe(false);
    }
    const derivativePuts = puts.mock.calls.map(([input]) => input).filter((input) => input.key.endsWith(".webp"));
    expect(derivativePuts).toHaveLength(3);
    for (const input of derivativePuts) expect(input.cacheControl).toBe("private, max-age=3600");
    // The crop (bottom square of the oriented portrait) is blue.
    const centre = await pixelAt(keys.large, 128, 128);
    expect(centre.b).toBeGreaterThan(200);
    expect(centre.r).toBeLessThan(60);

    const [row] = await getTestDb().select().from(people).where(eq(people.id, ancestor.id));
    expect(row?.photoKey).toBe(keys.large);
    expect(row?.updatedByUserId).toBe(admin.user.id);

    const revisions = await getTestDb().select().from(personRevisions).where(eq(personRevisions.personId, ancestor.id));
    expect(revisions).toHaveLength(1);
    expect(revisions[0]).toMatchObject({ action: "person.photo", actorUserId: admin.user.id });
    expect(revisions[0]?.before).toMatchObject({ type: "photo", personId: ancestor.id, hasPhoto: false });
    expect(revisions[0]?.after).toMatchObject({ type: "photo", personId: ancestor.id, hasPhoto: true });
    expect(JSON.stringify(revisions)).not.toContain("people/");

    const [audit] = await getTestDb().select().from(auditLogs).where(eq(auditLogs.action, "person.photo_updated"));
    expect(audit?.metadata).toEqual({ fields: ["photo"], uploadId: upload.uploadId, replaced: false });
    expect(confirmed.body).not.toContain("objectKey");
    // Object keys (`people/{personId}/{uploadId}…`) never reach a log line; route URLs do.
    expect(logs.join("\n")).not.toMatch(/people\/[0-9a-f-]{36}\/[0-9a-f-]{36}[.-]/);
  });

  it("clamps an oversized, out-of-bounds crop instead of failing", async () => {
    const admin = await actor({ role: "admin" });
    const person = await insertPerson();
    const { confirmed, upload } = await uploadPhoto(admin.auth, person.id, await orientedJpeg(), {
      x: 30_000,
      y: 30_000,
      size: 30_000
    });
    expect(confirmed.statusCode).toBe(200);
    // side = min(30000, 100, 200) = 100, shifted to the bottom-right: the blue half.
    const centre = await pixelAt(personPhotoKeys(person.id, upload.uploadId, "image/jpeg").large, 128, 128);
    expect(centre.b).toBeGreaterThan(200);
  });

  it("rejects non-integer, negative or extra crop fields with 400 before touching the upload", async () => {
    const admin = await actor({ role: "admin" });
    const person = await insertPerson();
    const body = await orientedJpeg();
    const created = (await intent(admin.auth, person.id, body.byteLength)).json<PersonPhotoUploadResponse>();
    await storage.simulateUpload(await objectKeyOf(created.uploadId), body, "image/jpeg");
    for (const crop of [{ x: 1.5, y: 0, size: 10 }, { x: -1, y: 0, size: 10 }, { x: 0, y: 0, size: 0 }, { x: 0, y: 0, size: 10, w: 3 }, { x: 0, y: 0, size: 30_001 }]) {
      const response = await confirm(admin.auth, person.id, created.uploadId, { crop });
      expect(response.statusCode).toBe(400);
      expect(errorOf(response.body).code).toBe("VALIDATION");
    }
    const [row] = await getTestDb().select().from(personPhotoUploads).where(eq(personPhotoUploads.id, created.uploadId));
    expect(row?.confirmedAt).toBeNull();
  });

  it("replaces a previous photo and deletes its objects; a repeat confirm is idempotent", async () => {
    const admin = await actor({ role: "admin" });
    const person = await insertPerson();
    const first = await uploadPhoto(admin.auth, person.id, await orientedJpeg());
    const firstKeys = personPhotoKeys(person.id, first.upload.uploadId, "image/jpeg");
    const second = await uploadPhoto(admin.auth, person.id, await orientedJpeg());
    expect(second.confirmed.statusCode).toBe(200);
    const secondKeys = personPhotoKeys(person.id, second.upload.uploadId, "image/jpeg");
    expect([...storage.objects.keys()].sort()).toEqual([secondKeys.display, secondKeys.large, secondKeys.small].sort());
    expect(storage.objects.has(firstKeys.large)).toBe(false);

    const again = await confirm(admin.auth, person.id, second.upload.uploadId);
    expect(again.statusCode).toBe(200);
    expect(await getTestDb().select().from(personRevisions).where(eq(personRevisions.personId, person.id))).toHaveLength(2);
  });

  it("rejects a magic-byte mismatch: row and object deleted, audited, 400", async () => {
    const admin = await actor({ role: "admin" });
    const person = await insertPerson();
    const body = Buffer.from("this is not an image at all, just text bytes");
    const created = (await intent(admin.auth, person.id, body.byteLength)).json<PersonPhotoUploadResponse>();
    const key = await objectKeyOf(created.uploadId);
    await storage.simulateUpload(key, body, "image/jpeg");
    const response = await confirm(admin.auth, person.id, created.uploadId);
    expect(response.statusCode).toBe(400);
    expect(errorOf(response.body).code).toBe("UPLOAD_INVALID");
    expect(storage.objects.has(key)).toBe(false);
    expect(await getTestDb().select().from(personPhotoUploads).where(eq(personPhotoUploads.id, created.uploadId))).toHaveLength(0);
    const [audit] = await getTestDb().select().from(auditLogs).where(eq(auditLogs.action, "person.photo_rejected"));
    expect(audit?.metadata).toEqual({ uploadId: created.uploadId, reason: "signature_mismatch" });
  });

  it("binds the presigned PUT to the declared type and length under a server-chosen key", async () => {
    const admin = await actor({ role: "admin" });
    const person = await insertPerson();
    const response = await app.inject({
      method: "POST",
      url: `/api/family/people/${person.id}/photo/uploads`,
      ...admin.auth,
      payload: { mimeType: "image/png", byteSize: 1234, objectKey: "people/evil.png", personId: "x" }
    });
    expect(response.statusCode).toBe(201);
    const put = storage.presignedPuts.at(-1);
    expect(put).toMatchObject({ contentType: "image/png", contentLength: 1234 });
    expect(put?.key).toMatch(new RegExp(`^people/${person.id}/[0-9a-f-]{36}\\.png$`));
    expect(response.body).not.toContain("objectKey");
  });
});

describe("who may change a tree photo", () => {
  /**
   * grandparent → parent → me ↔ partner, me → child; sibling shares parent.
   * All edges admin-created (qualifying).
   */
  async function family(): Promise<Record<"grandparent" | "parent" | "partner" | "child" | "sibling" | "stranger", string> & { me: Actor & { personId: string } }> {
    const me = await linkedMember();
    const grandparent = await insertPerson({ fullName: "Abuelo", deceased: true });
    const parent = await insertPerson({ fullName: "Mamá" });
    const partner = await insertPerson({ fullName: "Pareja" });
    const child = await insertPerson({ fullName: "Hija" });
    const sibling = await insertPerson({ fullName: "Hermano" });
    const stranger = await insertPerson({ fullName: "Desconocido" });
    await insertParentOf(grandparent.id, parent.id);
    await insertParentOf(parent.id, me.personId);
    await insertParentOf(parent.id, sibling.id);
    await insertPartnerOf(partner.id, me.personId);
    await insertParentOf(me.personId, child.id);
    return { me, grandparent: grandparent.id, parent: parent.id, partner: partner.id, child: child.id, sibling: sibling.id, stranger: stranger.id };
  }

  it("allows close relatives (parent, child, partner) and refuses everyone else with 403 FAMILY_NOT_IN_CIRCLE", async () => {
    const tree = await family();
    for (const target of [tree.parent, tree.child, tree.partner]) {
      expect((await intent(tree.me.auth, target, 100)).statusCode).toBe(201);
    }
    for (const target of [tree.grandparent, tree.sibling, tree.stranger]) {
      const response = await intent(tree.me.auth, target, 100);
      expect(response.statusCode).toBe(403);
      expect(errorOf(response.body)).toEqual({ code: "FORBIDDEN", detailCode: "FAMILY_NOT_IN_CIRCLE" });
    }
  });

  it("lets a linked member change their own photo but not a linked relative's (403 PERSON_LINKED_TO_OTHER)", async () => {
    const tree = await family();
    expect((await intent(tree.me.auth, tree.me.personId, 100)).statusCode).toBe(201);
    const relative = await createUser({ emailVerified: true });
    await getTestDb().update(people).set({ userId: relative.id }).where(eq(people.id, tree.parent));
    const response = await intent(tree.me.auth, tree.parent, 100);
    expect(response.statusCode).toBe(403);
    expect(errorOf(response.body).detailCode).toBe("PERSON_LINKED_TO_OTHER");
  });

  it("ignores a member-made edge whose creator created neither endpoint (planted), and honours a valid one", async () => {
    const me = await linkedMember();
    const intruder = await createUser({ emailVerified: true });
    const target = await insertPerson({ fullName: "Ajeno" });
    // Planted: created_by_member, but the creator made neither person.
    await getTestDb().insert(personRelationships).values({
      kind: "parent_of",
      fromPersonId: target.id,
      toPersonId: me.personId,
      createdByMember: true,
      createdByUserId: intruder.id
    });
    expect(await isCloseRelative(getTestDb(), me.personId, target.id)).toBe(false);
    expect((await intent(me.auth, target.id, 100)).statusCode).toBe(403);

    // A member-made edge with a person that member created qualifies.
    const added = await insertPerson({ fullName: "Hijo agregado", createdByUserId: me.user.id });
    await getTestDb().insert(personRelationships).values({
      kind: "parent_of",
      fromPersonId: me.personId,
      toPersonId: added.id,
      createdByMember: true,
      createdByUserId: me.user.id
    });
    expect(await isCloseRelative(getTestDb(), me.personId, added.id)).toBe(true);
    expect(await isCloseRelative(getTestDb(), added.id, me.personId)).toBe(true);
    expect((await intent(me.auth, added.id, 100)).statusCode).toBe(201);
  });

  it("refuses members without a linked person and unverified members", async () => {
    const person = await insertPerson();
    const unlinked = await actor();
    expect((await intent(unlinked.auth, person.id, 100)).statusCode).toBe(403);
    const unverified = await actor({ emailVerified: false });
    const response = await intent(unverified.auth, person.id, 100);
    expect(response.statusCode).toBe(403);
    expect(errorOf(response.body).code).toBe("EMAIL_UNVERIFIED");
    expect((await app.inject({ method: "POST", url: `/api/family/people/${person.id}/photo/uploads`, payload: { mimeType: "image/png", byteSize: 1 } })).statusCode).toBe(401);
  });

  it("answers 404 for an unknown person", async () => {
    const admin = await actor({ role: "admin" });
    const response = await intent(admin.auth, "6f1c2b3a-0000-4000-8000-000000000000", 100);
    expect(response.statusCode).toBe(404);
  });
});

describe("confirm is uploader-only (IDOR)", () => {
  it("answers 404 for another member's upload or another person's path, leaving everything untouched", async () => {
    const owner = await actor({ role: "admin" });
    const other = await actor({ role: "admin" });
    const person = await insertPerson();
    const elsewhere = await insertPerson();
    const body = await orientedJpeg();
    const created = (await intent(owner.auth, person.id, body.byteLength)).json<PersonPhotoUploadResponse>();
    await storage.simulateUpload(await objectKeyOf(created.uploadId), body, "image/jpeg");

    expect((await confirm(other.auth, person.id, created.uploadId)).statusCode).toBe(404);
    expect((await confirm(owner.auth, elsewhere.id, created.uploadId)).statusCode).toBe(404);
    const [row] = await getTestDb().select().from(personPhotoUploads).where(eq(personPhotoUploads.id, created.uploadId));
    expect(row?.confirmedAt).toBeNull();
    const [target] = await getTestDb().select().from(people).where(eq(people.id, person.id));
    expect(target?.photoKey).toBeNull();
    expect((await confirm(owner.auth, person.id, created.uploadId)).statusCode).toBe(200);
  });

  it("re-checks the permission at confirm (edge removed after the intent → 403)", async () => {
    const me = await linkedMember();
    const child = await insertPerson();
    const edge = await insertParentOf(me.personId, child.id);
    const body = await orientedJpeg();
    const created = (await intent(me.auth, child.id, body.byteLength)).json<PersonPhotoUploadResponse>();
    await storage.simulateUpload(await objectKeyOf(created.uploadId), body, "image/jpeg");
    await getTestDb().delete(personRelationships).where(eq(personRelationships.id, edge.id));
    const response = await confirm(me.auth, child.id, created.uploadId);
    expect(response.statusCode).toBe(403);
    const [target] = await getTestDb().select().from(people).where(eq(people.id, child.id));
    expect(target?.photoKey).toBeNull();
  });
});

describe("DELETE /api/family/people/:id/photo", () => {
  it("clears the photo, deletes its objects and records a revision; repeating is a no-op", async () => {
    const admin = await actor({ role: "admin" });
    const person = await insertPerson();
    const { upload } = await uploadPhoto(admin.auth, person.id, await orientedJpeg());
    const response = await app.inject({ method: "DELETE", url: `/api/family/people/${person.id}/photo`, ...admin.auth });
    expect(response.statusCode).toBe(200);
    expect(response.json<PersonDetails>()).toMatchObject({ photoUrl: null, photoSource: null, avatarUrl: null });
    const keys = personPhotoKeys(person.id, upload.uploadId, "image/jpeg");
    expect(storage.objects.has(keys.large)).toBe(false);
    expect(storage.objects.size).toBe(0);
    const revisions = await getTestDb().select().from(personRevisions).where(eq(personRevisions.personId, person.id));
    expect(revisions).toHaveLength(2);
    expect(revisions.find((revision) => revision.after?.type === "photo" && !revision.after.hasPhoto)).toBeDefined();

    const again = await app.inject({ method: "DELETE", url: `/api/family/people/${person.id}/photo`, ...admin.auth });
    expect(again.statusCode).toBe(200);
    expect(await getTestDb().select().from(personRevisions).where(eq(personRevisions.personId, person.id))).toHaveLength(2);
  });

  it("refuses a non-relative with 403 and keeps the photo", async () => {
    const admin = await actor({ role: "admin" });
    const person = await insertPerson();
    await uploadPhoto(admin.auth, person.id, await orientedJpeg());
    const stranger = await linkedMember();
    const response = await app.inject({ method: "DELETE", url: `/api/family/people/${person.id}/photo`, ...stranger.auth });
    expect(response.statusCode).toBe(403);
    const [row] = await getTestDb().select().from(people).where(eq(people.id, person.id));
    expect(row?.photoKey).not.toBeNull();
  });
});

describe("photo precedence and visibility", () => {
  it("shows the linked account's avatar first and the tree photo once the avatar is removed", async () => {
    const admin = await actor({ role: "admin" });
    const owner = await linkedMember();
    const viewer = await actor();
    await uploadPhoto(admin.auth, owner.personId, await orientedJpeg());

    const avatarKey = avatarKeys(owner.user.id, "0f2c4e1a-0000-4000-8000-000000000001", "image/jpeg").large;
    await getTestDb().update(profiles).set({ avatarKey }).where(eq(profiles.userId, owner.user.id));
    const withAvatar = (await app.inject({ method: "GET", url: `/api/family/people/${owner.personId}`, ...viewer.auth })).json<PersonDetails>();
    expect(withAvatar.photoSource).toBe("avatar");
    expect(withAvatar.avatarUrl).toContain("avatars/");

    await getTestDb().update(profiles).set({ avatarKey: null }).where(eq(profiles.userId, owner.user.id));
    const withoutAvatar = (await app.inject({ method: "GET", url: `/api/family/people/${owner.personId}`, ...viewer.auth })).json<PersonDetails>();
    expect(withoutAvatar.photoSource).toBe("person");
    expect(withoutAvatar.avatarUrl).toContain("people/");
    expect(withoutAvatar.canEditPhoto).toBe(false);
  });

  it("hides a linked person's tree photo from others when the account is unlisted or disabled", async () => {
    const admin = await actor({ role: "admin" });
    const owner = await linkedMember({ profile: { listedInDirectory: false } });
    const viewer = await actor();
    await uploadPhoto(admin.auth, owner.personId, await orientedJpeg());

    const hidden = (await app.inject({ method: "GET", url: `/api/family/people/${owner.personId}`, ...viewer.auth })).json<PersonDetails>();
    expect(hidden).toMatchObject({ photoUrl: null, photoSource: null, avatarUrl: null });
    const own = (await app.inject({ method: "GET", url: `/api/family/people/${owner.personId}`, ...owner.auth })).json<PersonDetails>();
    expect(own.photoSource).toBe("person");
    expect(own.canEditPhoto).toBe(true);

    await getTestDb().update(profiles).set({ listedInDirectory: true }).where(eq(profiles.userId, owner.user.id));
    expect((await app.inject({ method: "GET", url: `/api/family/people/${owner.personId}`, ...viewer.auth })).json<PersonDetails>().photoSource).toBe("person");
  });

  it("puts the tree photo on the tree's people (64 px rings, 256 px focus)", async () => {
    const admin = await actor({ role: "admin" });
    const me = await linkedMember();
    const grandmother = await insertPerson({ fullName: "Bisabuela", deceased: true });
    await insertParentOf(grandmother.id, me.personId);
    const { upload } = await uploadPhoto(admin.auth, grandmother.id, await orientedJpeg());

    const view = (await app.inject({ method: "GET", url: "/api/family/tree", ...me.auth })).json<FamilyTreeView>();
    expect(view.parents[0]?.avatarUrl).toContain(`${upload.uploadId}-64.webp`);
    const focused = (await app.inject({ method: "GET", url: `/api/family/tree?personId=${grandmother.id}`, ...me.auth })).json<FamilyTreeView>();
    expect(focused.focus.avatarUrl).toContain(`${upload.uploadId}-256.webp`);
  });

  it("resolvePersonPhoto falls back to the tree photo when the avatar presign fails, and refuses foreign keys", async () => {
    const personId = "1b2c3d4e-5f60-4b7c-9d8e-0f1a2b3c4d5e";
    const uploadId = "2b2c3d4e-5f60-4b7c-9d8e-0f1a2b3c4d5e";
    const photoKey = personPhotoKeys(personId, uploadId, "image/png").large;
    const failingAvatar = {
      storage: {
        presignGet: async (input: { key: string }) => {
          if (input.key.startsWith("avatars/")) throw new Error("down");
          return { url: `https://bucket.test/${input.key}`, expiresAt: new Date() };
        }
      },
      log: { warn: () => undefined }
    };
    const avatarKey = avatarKeys(personId, uploadId, "image/png").large;
    expect(await resolvePersonPhoto(failingAvatar, { avatarKey, photoKey }, PersonPhotoSize.Display)).toEqual({
      photoUrl: `https://bucket.test/people/${personId}/${uploadId}-512.webp`,
      photoSource: "person"
    });
    expect(await resolvePersonPhoto(failingAvatar, { avatarKey: null, photoKey: "people/../secret.webp" })).toBeNull();
    expect(personPhotoDerivativeKeys(`avatars/${personId}/${uploadId}-256.webp`)).toBeNull();
  });
});

describe("personPhotoObjectKeys / deletePersonPhotoObjects (for the admin person delete)", () => {
  it("lists the current derivatives and pending originals, and deletes them all", async () => {
    const admin = await actor({ role: "admin" });
    const person = await insertPerson();
    const { upload } = await uploadPhoto(admin.auth, person.id, await orientedJpeg());
    const pending = (await intent(admin.auth, person.id, 10)).json<PersonPhotoUploadResponse>();
    const pendingKey = await objectKeyOf(pending.uploadId);
    await storage.simulateUpload(pendingKey, new Uint8Array([1]), "image/jpeg");

    const keys = await personPhotoObjectKeys(getTestDb(), person.id);
    const current = personPhotoKeys(person.id, upload.uploadId, "image/jpeg");
    expect(keys).toEqual(expect.arrayContaining([current.display, current.large, current.small, pendingKey]));
    await deletePersonPhotoObjects(app, keys);
    expect(storage.objects.size).toBe(0);
  });
});
