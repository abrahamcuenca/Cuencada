/**
 * Test fixtures and MSW handlers for the profile feature (tests only).
 * Responses are `parse`d by the contract schemas, and request bodies are
 * validated like the server would, so a drift fails here first.
 */
import {
  avatarConfirmInputSchema,
  avatarUploadInputSchema,
  type AvatarUploadResponse,
  avatarUploadResponseSchema,
  errorHttpStatus,
  type OwnProfile,
  ownProfileSchema,
  updateProfileInputSchema
} from "@cuencada/types";
import { HttpResponse, http, type HttpHandler } from "msw";
import { apiUrl, errorBody, makeUser } from "../../../test/auth";
import type { ProfileWithListing } from "./lib/profileForm";

/** The bucket origin tests configure as `env.mediaUploadOrigin`. */
export const AVATAR_BUCKET_ORIGIN = "https://bucket.example";

/** The signed avatar URL the fake API hands out. */
export const AVATAR_PUT_URL = `${AVATAR_BUCKET_ORIGIN}/avatars/obj-1?X-Amz-Signature=supersecret`;

/** Signed headers of the fake intent (one forbidden header the client must skip). */
export const AVATAR_SIGNED_HEADERS: Readonly<Record<string, string>> = {
  "Content-Type": "image/jpeg",
  "Content-Length": "2048",
  "x-amz-acl": "private"
};

const UPLOAD_ID = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";

/** A valid own profile for the default test user. */
export function makeProfile(overrides: Partial<OwnProfile> = {}): OwnProfile {
  const user = makeUser();
  return ownProfileSchema.parse({
    userId: user.id,
    personId: null,
    email: user.email,
    displayName: "Rosa",
    fullName: "Rosa Elena Cuenca",
    familyBranch: "Familia de Jorge",
    city: "Mérida",
    phone: null,
    bio: null,
    avatarUrl: null,
    visibility: { showEmail: true, showPhone: false, showCity: true },
    updatedAt: "2026-10-01T12:00:00.000Z",
    ...overrides
  });
}

/** Mutable state behind {@link profileHandlers}. */
export interface FakeProfileDb {
  profile: ProfileWithListing;
  /** PATCH bodies, in order. */
  patches: unknown[];
  /** Intent and confirm bodies, in order. */
  intents: unknown[];
  confirms: unknown[];
  /** `uploadUrl` returned by the intent. */
  uploadUrl: string;
  /** Status of the next PATCH (200 by default). */
  patchStatus: 200 | 400 | 429 | 500;
}

/** A fresh fake database. */
export function makeProfileDb(profile: ProfileWithListing = makeProfile()): FakeProfileDb {
  return { profile, patches: [], intents: [], confirms: [], uploadUrl: AVATAR_PUT_URL, patchStatus: 200 };
}

/** Applies a validated PATCH to the fake profile (contract fields and the proposed extensions). */
function applyPatch(profile: ProfileWithListing, body: Record<string, unknown>): ProfileWithListing {
  const next: ProfileWithListing = { ...profile, visibility: { ...profile.visibility } };
  for (const key of ["displayName", "fullName", "familyBranch", "city", "phone", "bio"] as const) {
    if (key in body) Object.assign(next, { [key]: body[key] });
  }
  for (const key of ["showEmail", "showPhone", "showCity", "listedInDirectory"] as const) {
    if (typeof body[key] === "boolean") Object.assign(next.visibility, { [key]: body[key] });
  }
  next.updatedAt = new Date().toISOString();
  return next;
}

/**
 * @param db - The fake database.
 * @returns Handlers for `/profile/me` and the avatar endpoints.
 */
export function profileHandlers(db: FakeProfileDb): HttpHandler[] {
  return [
    http.get(apiUrl("/profile/me"), () => HttpResponse.json(db.profile)),
    http.patch(apiUrl("/profile/me"), async ({ request }) => {
      const body: unknown = await request.json();
      db.patches.push(body);
      if (db.patchStatus === 429) return HttpResponse.json(errorBody("RATE_LIMITED"), { status: errorHttpStatus.RATE_LIMITED });
      if (db.patchStatus === 500) return HttpResponse.json(errorBody("INTERNAL", "Algo salió mal en el servidor."), { status: 500 });
      const fields = typeof body === "object" && body !== null ? body : {};
      // `listedInDirectory` is pending in the contract (WP-2.1); everything else must pass it.
      const onlyListing = Object.keys(fields).length > 0 && Object.keys(fields).every((key) => key === "listedInDirectory");
      if (!onlyListing && !updateProfileInputSchema.safeParse(body).success) return HttpResponse.json(errorBody("VALIDATION"), { status: 400 });
      // Safe: a JSON object body, checked just above.
      db.profile = applyPatch(db.profile, fields as Record<string, unknown>);
      return HttpResponse.json(db.profile);
    }),
    http.post(apiUrl("/profile/me/avatar/uploads"), async ({ request }) => {
      const body: unknown = await request.json();
      db.intents.push(body);
      if (!avatarUploadInputSchema.safeParse(body).success) return HttpResponse.json(errorBody("VALIDATION"), { status: 400 });
      const intent: AvatarUploadResponse = avatarUploadResponseSchema.parse({
        uploadId: UPLOAD_ID,
        uploadUrl: db.uploadUrl,
        headers: AVATAR_SIGNED_HEADERS,
        expiresAt: new Date(Date.now() + 10 * 60_000).toISOString()
      });
      return HttpResponse.json(intent, { status: 201 });
    }),
    http.post(apiUrl("/profile/me/avatar/confirm"), async ({ request }) => {
      const body: unknown = await request.json();
      db.confirms.push(body);
      if (!avatarConfirmInputSchema.safeParse(body).success) return HttpResponse.json(errorBody("VALIDATION"), { status: 400 });
      db.profile = { ...db.profile, avatarUrl: "https://bucket.example/avatars/new.webp?X-Amz-Signature=a1", updatedAt: new Date().toISOString() };
      return HttpResponse.json(db.profile);
    }),
    // `refreshCurrentUser()` after a save.
    http.get(apiUrl("/me"), () => HttpResponse.json(makeUser()))
  ];
}

/**
 * @param name - File name.
 * @param type - MIME type.
 * @param size - Reported size in bytes.
 * @returns A `File` whose `size` is faked (no big buffers in tests).
 */
export function fileOf(name: string, type: string, size = 2048): File {
  const file = new File(["x"], name, { type });
  Object.defineProperty(file, "size", { value: size });
  return file;
}
