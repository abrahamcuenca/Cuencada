/**
 * Member family-tree routes under `/api/family`. Every route needs a
 * logged-in member with a **verified email** (`requireVerifiedEmail`):
 * tree data is PII. Response schemas strip anything outside the contract.
 */
import {
  AuditAction,
  AuditEntityType,
  apiErrorSchema,
  familyTreeQuerySchema,
  familyTreeViewSchema,
  idParamSchema,
  type Page,
  type Person,
  type PersonDetails,
  type PersonSummary,
  pageSchema,
  peopleQuerySchema,
  personDetailsSchema,
  personSchema,
  personSummarySchema,
  type SelfEditPersonInput,
  selfEditPersonInputSchema
} from "@cuencada/types";
import { and, eq, ilike, or, type SQL, sql } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import type { RouteShorthandOptions } from "fastify";
import { z } from "zod";
import { people } from "../../db/schema/index.js";
import { recordAudit, type Transaction } from "../../lib/audit.js";
import { AppError } from "../../lib/errors.js";
import { rateLimitByIp } from "../../lib/rateLimit.js";
import { authUser } from "../../plugins/auth.js";
import { PgErrorCode, pgErrorInfo } from "./db-errors.js";
import { AvatarSize } from "../profile/constants.js";
import {
  escapeLike,
  findPerson,
  findPersonByUserId,
  type PersonRow,
  personColumns,
  presignPersonAvatars,
  selectPersonViews,
  toPersonSummary,
  toPersonWithAvatar
} from "./repository.js";
import { buildPersonDetails } from "./personDetails.js";
import { loadTreeView } from "./tree.js";

const NOT_LINKED_MESSAGE = "Tu cuenta no está vinculada a ninguna persona del árbol familiar.";
const PERSON_NOT_FOUND_MESSAGE = "No encontramos a esa persona.";
const BIRTH_YEAR_MESSAGE = "El año de nacimiento no es compatible con el año de fallecimiento registrado.";

/* -------------------------------- Cursor -------------------------------- */

/**
 * The search cursor holds only the last person's id (not the name, which
 * would put PII into URLs and access logs); the keyset value is looked up.
 */
const cursorPayloadSchema = z.tuple([z.uuid()]);

function encodeCursor(id: string): string {
  return Buffer.from(JSON.stringify([id])).toString("base64url");
}

/**
 * @throws AppError `VALIDATION` for a malformed cursor (client input).
 */
function decodeCursor(value: string): string {
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    raw = undefined;
  }
  const parsed = cursorPayloadSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AppError("VALIDATION", "Cursor inválido.", { details: [{ path: "cursor", message: "Cursor inválido." }] });
  }
  return parsed.data[0];
}

/* ------------------------------- Self edit ------------------------------ */

/** `set` values for a self edit: only the whitelisted keys that were sent. */
function selfEditValues(input: SelfEditPersonInput): Partial<typeof people.$inferInsert> {
  const values: Partial<typeof people.$inferInsert> = {};
  if (input.nickname !== undefined) values.nickname = input.nickname;
  if (input.familyBranch !== undefined) values.familyBranch = input.familyBranch;
  if (input.birthYear !== undefined) values.birthYear = input.birthYear;
  return values;
}

/**
 * Update the caller's own person row. The `user_id` predicate re-checks
 * ownership in the statement itself.
 *
 * @throws AppError `VALIDATION` when the birth year breaks a CHECK (e.g. after the death year).
 */
async function updateOwnPerson(
  tx: Transaction,
  personId: string,
  userId: string,
  values: Partial<typeof people.$inferInsert>
): Promise<PersonRow | undefined> {
  try {
    const [updated] = await tx
      .update(people)
      .set(values)
      .where(and(eq(people.id, personId), eq(people.userId, userId)))
      .returning(personColumns);
    return updated;
  } catch (error) {
    if (pgErrorInfo(error)?.code === PgErrorCode.CheckViolation) {
      throw new AppError("VALIDATION", BIRTH_YEAR_MESSAGE, {
        details: [{ path: "birthYear", message: BIRTH_YEAR_MESSAGE }],
        cause: error
      });
    }
    throw error;
  }
}

/* -------------------------------- Routes -------------------------------- */

/** Member family routes (mounted under `/api`). */
const memberFamilyRoutes: FastifyPluginAsyncZod = async (app) => {
  const memberConfig = { auth: "user", requireVerifiedEmail: true } as const;

  /** `GET /api/family/people`: search by name, nickname or branch; keyset-paginated by name. */
  app.get(
    "/family/people",
    {
      config: { ...memberConfig, rateLimit: rateLimitByIp({ max: 120, timeWindow: "1 minute" }) },
      schema: { querystring: peopleQuerySchema, response: { 200: pageSchema(personSummarySchema) } }
    },
    async (request): Promise<Page<PersonSummary>> => {
      const { q, cursor, limit } = request.query;
      const term = q === undefined || q === "" ? undefined : `%${escapeLike(q)}%`;
      const match: SQL | undefined =
        term === undefined
          ? undefined
          : or(ilike(people.fullName, term), ilike(people.nickname, term), ilike(people.familyBranch, term));
      const after = cursor === undefined ? undefined : decodeCursor(cursor);
      // A cursor whose person was deleted matches nothing (row comparison with NULL): the page ends.
      const keyset: SQL | undefined =
        after === undefined
          ? undefined
          : sql`(lower(${people.fullName}), ${people.id}) > (select lower(p.full_name), p.id from ${people} p where p.id = ${after}::uuid)`;
      const viewer = authUser(request);
      const rows = await selectPersonViews(app.db, and(match, keyset), {
        orderBy: [sql`lower(${people.fullName})`, sql`${people.id}`],
        limit: limit + 1
      });
      const pageRows = rows.slice(0, limit);
      const last = pageRows.at(-1);
      const avatars = await presignPersonAvatars(app, pageRows, viewer, AvatarSize.Small);
      return {
        items: pageRows.map((row) => toPersonSummary(row, viewer, avatars)),
        nextCursor: rows.length > limit && last !== undefined ? encodeCursor(last.id) : null
      };
    }
  );

  /**
   * `GET /api/family/people/:id`: one person as `PersonDetails` (a superset
   * of `Person`), privacy rules applied. Interim builder until WP-4.1.
   */
  app.get(
    "/family/people/:id",
    {
      config: memberConfig,
      schema: { params: idParamSchema, response: { 200: personDetailsSchema, 404: apiErrorSchema } }
    },
    async (request): Promise<PersonDetails> => {
      const viewer = authUser(request);
      const row = await findPerson(app.db, request.params.id);
      if (row === undefined) throw new AppError("NOT_FOUND", PERSON_NOT_FOUND_MESSAGE);
      return buildPersonDetails(app, row, viewer);
    }
  );

  /** `GET /api/family/tree`: person-centred view; defaults to the caller's own person. */
  app.get(
    "/family/tree",
    {
      config: memberConfig,
      schema: { querystring: familyTreeQuerySchema, response: { 200: familyTreeViewSchema, 404: apiErrorSchema } }
    },
    async (request) => {
      const viewer = authUser(request);
      let focusId = request.query.personId;
      if (focusId === undefined) {
        const own = await findPersonByUserId(app.db, viewer.id);
        if (own === undefined) throw new AppError("NOT_FOUND", NOT_LINKED_MESSAGE);
        focusId = own.id;
      }
      return loadTreeView(app, focusId, request.query.depth, viewer);
    }
  );

  /**
   * `PATCH /api/family/me` (and the alias `/api/family/people/me`): the
   * member edits nickname, branch and birth year of their **own** linked
   * person. Unknown keys (`userId`, `fullName`, `deceased`, relationships…)
   * are stripped by the schema and never reach the update.
   */
  const selfEditOptions = {
    config: memberConfig,
    schema: {
      body: selfEditPersonInputSchema,
      response: { 200: personSchema, 400: apiErrorSchema, 404: apiErrorSchema }
    }
  } satisfies RouteShorthandOptions;

  const selfEditHandler = async (viewer: ReturnType<typeof authUser>, input: SelfEditPersonInput, ip: string): Promise<Person> => {
    const saved = await app.db.transaction(async (tx) => {
      const own = await findPersonByUserId(tx, viewer.id);
      if (own === undefined) throw new AppError("NOT_FOUND", NOT_LINKED_MESSAGE);
      const values = selfEditValues(input);
      const updated = await updateOwnPerson(tx, own.id, viewer.id, values);
      if (updated === undefined) throw new AppError("NOT_FOUND", NOT_LINKED_MESSAGE);
      await recordAudit(tx, {
        actorUserId: viewer.id,
        action: AuditAction.PersonUpdated,
        entityType: AuditEntityType.Person,
        entityId: updated.id,
        metadata: { fields: Object.keys(values), self: true },
        ip
      });
      // Re-read with the profile join (avatar) inside the same transaction.
      const view = await findPerson(tx, updated.id);
      if (view === undefined) throw new AppError("NOT_FOUND", NOT_LINKED_MESSAGE);
      return view;
    });
    return toPersonWithAvatar(app, saved, viewer);
  };

  app.patch("/family/me", selfEditOptions, async (request) =>
    selfEditHandler(authUser(request), request.body, request.ip)
  );
  app.patch("/family/people/me", selfEditOptions, async (request) =>
    selfEditHandler(authUser(request), request.body, request.ip)
  );
};

export default memberFamilyRoutes;
