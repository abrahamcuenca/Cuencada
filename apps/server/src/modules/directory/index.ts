/**
 * Directory module (T5): the member directory. Registered under `/api` by
 * `app.ts`. Both routes are `auth: "user"` with `requireVerifiedEmail`, so
 * unverified members get 403 `EMAIL_UNVERIFIED` (ADR 0001).
 *
 * Every entry goes through `toDirectoryEntry()` and `directoryEntrySchema`:
 * hidden contact fields are absent, never `null`.
 */
import { directoryEntrySchema, directoryQuerySchema, idParamSchema, pageSchema } from "@cuencada/types";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { AppError } from "../../lib/errors.js";
import { DIRECTORY_DETAIL_RATE_LIMIT, DIRECTORY_SEARCH_RATE_LIMIT } from "../profile/constants.js";
import { rateLimitByUser, t5ErrorResponses } from "../profile/shared.js";
import { decodeDirectoryCursor, encodeDirectoryCursor } from "./cursor.js";
import { type DirectoryFilters, findDirectoryMember, listDirectory, toEntry } from "./repository.js";

const MEMBER_NOT_FOUND = "No encontramos a ese familiar en el directorio.";

/** Directory routes under `/api`. */
const directoryModule: FastifyPluginAsyncZod = async (app) => {
  /**
   * `GET /api/directory?q&familyBranch&city&cursor&limit`: listed (active)
   * members ordered by name. `q` matches only fields the member made visible.
   * 60/min per user.
   */
  app.get(
    "/directory",
    {
      config: {
        auth: "user",
        requireVerifiedEmail: true,
        rateLimit: rateLimitByUser("directory-search", DIRECTORY_SEARCH_RATE_LIMIT)
      },
      schema: {
        querystring: directoryQuerySchema,
        response: {
          200: pageSchema(directoryEntrySchema),
          ...t5ErrorResponses
        }
      }
    },
    async (request) => {
      const { q, familyBranch, city, cursor, limit } = request.query;
      const filters: DirectoryFilters = {};
      if (q !== undefined) filters.q = q;
      if (familyBranch !== undefined) filters.familyBranch = familyBranch;
      if (city !== undefined) filters.city = city;

      const rows = await listDirectory(
        app.db,
        filters,
        cursor === undefined ? null : decodeDirectoryCursor(cursor),
        limit
      );
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      const nextCursor = rows.length > limit && last !== undefined ? encodeDirectoryCursor(last.userId) : null;
      return {
        items: await Promise.all(page.map((row) => toEntry(app, row))),
        nextCursor
      };
    }
  );

  /** `GET /api/directory/:id` (user id): 404 when unknown, disabled or unlisted. 120/min per user. */
  app.get(
    "/directory/:id",
    {
      config: {
        auth: "user",
        requireVerifiedEmail: true,
        rateLimit: rateLimitByUser("directory-detail", DIRECTORY_DETAIL_RATE_LIMIT)
      },
      schema: {
        params: idParamSchema,
        response: { 200: directoryEntrySchema, ...t5ErrorResponses }
      }
    },
    async (request) => {
      const row = await findDirectoryMember(app.db, request.params.id);
      if (row === null) throw new AppError("NOT_FOUND", MEMBER_NOT_FOUND);
      return toEntry(app, row);
    }
  );
};

export default directoryModule;
