/**
 * Own-profile routes: `GET`/`PATCH /api/profile/me` and
 * `PATCH /api/profile/me/contacts` (WP-4.4).
 */
import { AuditAction, ownProfileSchema, updateContactsInputSchema, updateProfileInputSchema } from "@cuencada/types";
import { eq } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { profiles, users } from "../../db/schema/index.js";
import { recordAudit } from "../../lib/audit.js";
import { authUser } from "../../plugins/auth.js";
import { PROFILE_UPDATE_RATE_LIMIT } from "./constants.js";
import { buildContactsPatch, loadOwnProfile, splitProfilePatch, toOwnProfile } from "./service.js";
import { rateLimitByUser, t5ErrorResponses } from "./shared.js";

/** Audit action for a profile edit (metadata: changed field names only). */
export const PROFILE_UPDATED_ACTION = AuditAction.ProfileUpdated;

/** Own-profile routes under `/api`. */
const profileRoutes: FastifyPluginAsyncZod = async (app) => {
  /**
   * The caller's full profile, including hidden fields and visibility flags.
   * Allowed while the email is unverified (default guard: not while a
   * password change is pending).
   */
  app.get(
    "/profile/me",
    {
      config: { auth: "user" },
      schema: { response: { 200: ownProfileSchema, ...t5ErrorResponses } }
    },
    async (request) => {
      const user = authUser(request);
      return toOwnProfile(app, await loadOwnProfile(app.db, user.id));
    }
  );

  /**
   * Edit the caller's profile. The body is the strict contract schema, so
   * `role`, `status`, `userId`, `email`, `avatarKey`… are a 400. A new
   * `displayName` is written to `users.display_name` (the account's name).
   * Audited with the changed field names only, never the values.
   */
  app.patch(
    "/profile/me",
    {
      config: {
        auth: "user",
        rateLimit: rateLimitByUser("profile-update", PROFILE_UPDATE_RATE_LIMIT)
      },
      schema: {
        body: updateProfileInputSchema,
        response: { 200: ownProfileSchema, ...t5ErrorResponses }
      }
    },
    async (request) => {
      const user = authUser(request);
      const { profile: patch, displayName } = splitProfilePatch(request.body);
      const record = await app.db.transaction(async (tx) => {
        const current = await loadOwnProfile(tx, user.id, { forUpdate: true });
        const now = app.clock.now();
        if (displayName !== undefined) {
          await tx.update(users).set({ displayName, updatedAt: now }).where(eq(users.id, user.id));
        }
        await tx
          .update(profiles)
          .set({ ...patch, updatedAt: now })
          .where(eq(profiles.id, current.profile.id));
        await recordAudit(tx, {
          actorUserId: user.id,
          action: PROFILE_UPDATED_ACTION,
          entityType: "profile",
          entityId: current.profile.id,
          metadata: { fields: Object.keys(request.body).sort() },
          ip: request.ip
        });
        return loadOwnProfile(tx, user.id);
      });
      return toOwnProfile(app, record);
    }
  );

  /**
   * Edit the caller's contacts and their "Mostrar a la familia" switches
   * (WP-4.4). Strict contract body: phone/WhatsApp are normalized to E.164,
   * handles must be bare handles (a pasted URL is a 400), the website must be
   * https. Only the caller's own row is ever written (no id in the path or
   * body). Same per-user rate limit as the profile edit. Audited as `profile.updated`
   * with the changed field names only (`contacts.<name>`), never the values.
   */
  app.patch(
    "/profile/me/contacts",
    {
      config: {
        auth: "user",
        rateLimit: rateLimitByUser("profile-contacts-update", PROFILE_UPDATE_RATE_LIMIT)
      },
      schema: {
        body: updateContactsInputSchema,
        response: { 200: ownProfileSchema, ...t5ErrorResponses }
      }
    },
    async (request) => {
      const user = authUser(request);
      const record = await app.db.transaction(async (tx) => {
        const current = await loadOwnProfile(tx, user.id, { forUpdate: true });
        const { patch, fields } = buildContactsPatch(request.body, current.profile.contactVisibility);
        await tx
          .update(profiles)
          .set({ ...patch, updatedAt: app.clock.now() })
          .where(eq(profiles.id, current.profile.id));
        await recordAudit(tx, {
          actorUserId: user.id,
          action: PROFILE_UPDATED_ACTION,
          entityType: "profile",
          entityId: current.profile.id,
          metadata: { fields: fields.map((field) => `contacts.${field}`) },
          ip: request.ip
        });
        return loadOwnProfile(tx, user.id);
      });
      return toOwnProfile(app, record);
    }
  );
};

export default profileRoutes;
