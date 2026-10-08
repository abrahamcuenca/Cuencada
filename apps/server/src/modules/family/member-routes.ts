/**
 * Member family-tree routes under `/api/family`. Every route needs a
 * logged-in member with a **verified email** (`requireVerifiedEmail`):
 * tree data is PII. Response schemas strip anything outside the contract.
 *
 * Writes (WP-4.1, ADR 0001 §6): members add new relatives attached to their
 * qualifying own-family circle, edit people in it, and delete only their own
 * unlinked additions. There are **no** member relationship routes. Every
 * write takes the tree lock, recomputes the circle inside the transaction,
 * writes a revision and an audit row, and is rate limited per user.
 */
import {
  apiErrorSchema,
  type FamilyIssueCode,
  FamilyIssueCode as Issue,
  familyTreeQuerySchema,
  familyTreeViewSchema,
  idParamSchema,
  type MemberUpdatePersonInput,
  memberCreatePersonInputSchema,
  memberUpdatePersonInputSchema,
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
import { and, ilike, or, type SQL, sql } from "drizzle-orm";
import type { FastifyInstance, RouteShorthandOptions } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { people } from "../../db/schema/index.js";
import type { DbOrTx, Transaction } from "../../lib/audit.js";
import { AppError, isAppError } from "../../lib/errors.js";
import { extraRateLimitHook, ipKey, rateLimitByIp } from "../../lib/rateLimit.js";
import { type AuthUser, authUser } from "../../plugins/auth.js";
import { AvatarSize } from "../profile/constants.js";
import { EMPTY_CIRCLE, type FamilyCircle, loadFamilyCircle } from "./circle.js";
import { buildPersonDetails, hasForeignEdges, memberCanEdit } from "./details.js";
import { lockFamilyTree } from "./relationships.js";
import {
  escapeLike,
  findPerson,
  findPersonByUserId,
  presignPersonAvatars,
  selectPersonViews,
  toPersonSummary,
  toPersonWithAvatar,
  type Viewer
} from "./repository.js";
import { loadTreeView } from "./tree.js";
import { PERSON_NOT_FOUND, type PersonPatch, createPersonTx, deletePersonTx, lockPersonRow, updatePersonTx } from "./writes.js";

const NOT_LINKED_MESSAGE = "Tu cuenta no está vinculada a ninguna persona del árbol familiar.";
const BIRTH_YEAR_MESSAGE = "El año de nacimiento no es compatible con el año de fallecimiento registrado.";
const NOT_IN_CIRCLE_MESSAGE = "Solo puedes cambiar a tu familia cercana. Pídele a un administrador que haga este cambio.";
const LINKED_TO_OTHER_MESSAGE = "Esta persona tiene su propia cuenta: solo ella o un administrador pueden cambiar sus datos.";
const NOT_CREATOR_MESSAGE = "Solo quien agregó a esta persona, o un administrador, puede quitarla del árbol.";
const HAS_RELATIONSHIPS_MESSAGE = "Esta persona tiene otras relaciones en el árbol. Pídele a un administrador que la quite.";

/** Member family writes per user (create, edit, delete, self edit): 60 per hour. */
export const MEMBER_FAMILY_WRITE_LIMIT = { max: 60, timeWindow: "1 hour" } as const;

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

/* -------------------------------- Helpers ------------------------------- */

/**
 * A family 403/409 with its stable reason in `details[0].code`
 * (`FamilyIssueCode`, ADR 0001 §4/§6).
 */
function familyError(code: "FORBIDDEN" | "CONFLICT", issue: FamilyIssueCode, message: string, path = "id"): AppError {
  return new AppError(code, message, { details: [{ path, message, code: issue }] });
}

/** The viewer and their circle (admins: full scope, no circle needed). */
async function viewerWithCircle(db: DbOrTx, user: AuthUser): Promise<{ viewer: Viewer; circle: FamilyCircle }> {
  const circle = user.role === "admin" ? EMPTY_CIRCLE : await loadFamilyCircle(db, user.id);
  return { viewer: { id: user.id, role: user.role, circle: circle.ids }, circle };
}

/** `set` values for a self edit: only the whitelisted keys that were sent. */
function selfEditValues(input: SelfEditPersonInput): PersonPatch {
  const values: PersonPatch = {};
  if (input.nickname !== undefined) values.nickname = input.nickname;
  if (input.familyBranch !== undefined) values.familyBranch = input.familyBranch;
  if (input.birthYear !== undefined) values.birthYear = input.birthYear;
  return values;
}

/** The keys of a member PATCH that were sent or derived (never `userId`: the schema has none). */
function memberPatch(input: MemberUpdatePersonInput): PersonPatch {
  const patch: PersonPatch = {};
  if (input.fullName !== undefined) patch.fullName = input.fullName;
  if (input.nickname !== undefined) patch.nickname = input.nickname;
  if (input.familyBranch !== undefined) patch.familyBranch = input.familyBranch;
  if (input.birthYear !== undefined) patch.birthYear = input.birthYear;
  if (input.deathYear !== undefined) patch.deathYear = input.deathYear;
  if (input.birthDate !== undefined) patch.birthDate = input.birthDate;
  if (input.deathDate !== undefined) patch.deathDate = input.deathDate;
  if (input.birthplace !== undefined) patch.birthplace = input.birthplace;
  if (input.bio !== undefined) patch.bio = input.bio;
  if (input.deceased !== undefined) patch.deceased = input.deceased;
  return patch;
}

/** Why `user` may not edit `row`: outside the circle, or linked to another account. */
function editDenial(row: { id: string; userId: string | null }, user: AuthUser): AppError {
  if (row.userId !== null && row.userId !== user.id) {
    return familyError("FORBIDDEN", Issue.PersonLinkedToOther, LINKED_TO_OTHER_MESSAGE);
  }
  return familyError("FORBIDDEN", Issue.NotInCircle, NOT_IN_CIRCLE_MESSAGE);
}

/** Re-read `id` with the joins and build the card for the writer, inside the transaction. */
async function detailsAfterWrite(app: FastifyInstance, tx: Transaction, id: string, user: AuthUser): Promise<PersonDetails> {
  const view = await findPerson(tx, id);
  if (view === undefined) throw new Error("person vanished inside its write transaction");
  const { viewer, circle } = await viewerWithCircle(tx, user);
  return buildPersonDetails({ db: tx, storage: app.storage, log: app.log }, view, viewer, circle);
}

/* -------------------------------- Routes -------------------------------- */

/** Member family routes (mounted under `/api`). */
const memberFamilyRoutes: FastifyPluginAsyncZod = async (app) => {
  const memberConfig = { auth: "user", requireVerifiedEmail: true } as const;
  // One counter shared by every member write route (a route's own
  // `config.rateLimit` would count each route separately).
  const writeLimit = extraRateLimitHook(app, {
    ...MEMBER_FAMILY_WRITE_LIMIT,
    keyGenerator: (request) => `family-write:${request.user === null ? ipKey(request) : `user:${request.user.id}`}`
  });
  const writeErrors = {
    400: apiErrorSchema,
    403: apiErrorSchema,
    404: apiErrorSchema,
    409: apiErrorSchema,
    429: apiErrorSchema
  };

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

  /** `GET /api/family/people/:id`: one person's card (`PersonDetails`), privacy rules applied. */
  app.get(
    "/family/people/:id",
    {
      config: memberConfig,
      schema: { params: idParamSchema, response: { 200: personDetailsSchema, 404: apiErrorSchema } }
    },
    async (request): Promise<PersonDetails> => {
      const user = authUser(request);
      const row = await findPerson(app.db, request.params.id);
      if (row === undefined) throw new AppError("NOT_FOUND", PERSON_NOT_FOUND);
      const { viewer, circle } = await viewerWithCircle(app.db, user);
      return buildPersonDetails(app, row, viewer, circle);
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
      const user = authUser(request);
      let focusId = request.query.personId;
      if (focusId === undefined) {
        const own = await findPersonByUserId(app.db, user.id);
        if (own === undefined) throw new AppError("NOT_FOUND", NOT_LINKED_MESSAGE);
        focusId = own.id;
      }
      const { viewer } = await viewerWithCircle(app.db, user);
      return loadTreeView(app, focusId, request.query.depth, viewer);
    }
  );

  /**
   * `POST /api/family/people`: a member adds a **new** relative attached to
   * someone in their qualifying circle (`relateTo`), in one transaction under
   * the tree lock. The edge is member-created (Security M1). `userId` is not
   * accepted (strict schema → 400). Admins have full scope (admin edge).
   */
  app.post(
    "/family/people",
    {
      config: memberConfig,
      preHandler: writeLimit,
      schema: { body: memberCreatePersonInputSchema, response: { 201: personDetailsSchema, ...writeErrors } }
    },
    async (request, reply): Promise<PersonDetails> => {
      const user = authUser(request);
      const { relateTo, ...values } = request.body;
      const anchorId = relateTo.personId.toLowerCase();
      const details = await app.db.transaction(async (tx) => {
        await lockFamilyTree(tx);
        const admin = user.role === "admin";
        // Admins have full scope (their edges are admin edges); members only within their circle.
        if (!admin && !(await loadFamilyCircle(tx, user.id)).ids.has(anchorId)) {
          throw familyError("FORBIDDEN", Issue.NotInCircle, NOT_IN_CIRCLE_MESSAGE, "relateTo.personId");
        }
        const { row } = await createPersonTx(tx, {
          values: { ...values, userId: null },
          relateTo: { personId: anchorId, kind: relateTo.kind },
          actor: { id: user.id, ip: request.ip },
          member: !admin
        });
        return detailsAfterWrite(app, tx, row.id, user);
      });
      return reply.code(201).send(details);
    }
  );

  /**
   * `PATCH /api/family/people/:id`: a member edits themself or someone in
   * their qualifying circle who is not linked to another account.
   */
  app.patch(
    "/family/people/:id",
    {
      config: memberConfig,
      preHandler: writeLimit,
      schema: {
        params: idParamSchema,
        body: memberUpdatePersonInputSchema,
        response: { 200: personDetailsSchema, ...writeErrors }
      }
    },
    async (request): Promise<PersonDetails> => {
      const user = authUser(request);
      const id = request.params.id.toLowerCase();
      return app.db.transaction(async (tx) => {
        await lockFamilyTree(tx);
        const before = await lockPersonRow(tx, id);
        if (before === undefined) throw new AppError("NOT_FOUND", PERSON_NOT_FOUND);
        if (user.role !== "admin") {
          const circle = await loadFamilyCircle(tx, user.id);
          if (!memberCanEdit(before, { id: user.id, role: user.role }, circle)) throw editDenial(before, user);
        }
        await updatePersonTx(tx, before, memberPatch(request.body), { id: user.id, ip: request.ip });
        return detailsAfterWrite(app, tx, id, user);
      });
    }
  );

  /**
   * `DELETE /api/family/people/:id`: a member removes a person **they
   * created**, without an account, whose only edges are the ones they made
   * together with it (removed in the same transaction).
   */
  app.delete(
    "/family/people/:id",
    {
      config: memberConfig,
      preHandler: writeLimit,
      schema: { params: idParamSchema, response: { 204: z.null(), ...writeErrors } }
    },
    async (request, reply) => {
      const user = authUser(request);
      const id = request.params.id.toLowerCase();
      await app.db.transaction(async (tx) => {
        await lockFamilyTree(tx);
        const row = await lockPersonRow(tx, id);
        const view = row === undefined ? undefined : await findPerson(tx, id);
        if (row === undefined || view === undefined) throw new AppError("NOT_FOUND", PERSON_NOT_FOUND);
        if (view.createdByUserId !== user.id) throw familyError("FORBIDDEN", Issue.NotCreator, NOT_CREATOR_MESSAGE);
        if (row.userId !== null) throw familyError("FORBIDDEN", Issue.PersonLinkedToOther, LINKED_TO_OTHER_MESSAGE);
        if (await hasForeignEdges(tx, id, user.id)) {
          throw familyError("CONFLICT", Issue.PersonHasRelationships, HAS_RELATIONSHIPS_MESSAGE);
        }
        await deletePersonTx(tx, row, { id: user.id, ip: request.ip });
      });
      return reply.code(204).send(null);
    }
  );

  /**
   * `PATCH /api/family/me` (and the alias `/api/family/people/me`): the
   * member edits nickname, branch and birth year of their **own** linked
   * person. Unknown keys (`userId`, `fullName`, `deceased`, relationships…)
   * are stripped by the schema and never reach the update. The merged row is
   * re-checked with `personDatesIssue()` and recorded as a revision.
   */
  const selfEditOptions = {
    config: memberConfig,
    preHandler: writeLimit,
    schema: {
      body: selfEditPersonInputSchema,
      response: { 200: personSchema, 400: apiErrorSchema, 404: apiErrorSchema, 429: apiErrorSchema }
    }
  } satisfies RouteShorthandOptions;

  const selfEditHandler = async (user: AuthUser, input: SelfEditPersonInput, ip: string): Promise<Person> => {
    const saved = await app.db.transaction(async (tx) => {
      const own = await findPersonByUserId(tx, user.id);
      const before = own === undefined ? undefined : await lockPersonRow(tx, own.id);
      if (before === undefined || before.userId !== user.id) throw new AppError("NOT_FOUND", NOT_LINKED_MESSAGE);
      try {
        await updatePersonTx(tx, before, selfEditValues(input), { id: user.id, ip }, { self: true });
      } catch (error) {
        // The member only sends a birth year here: report any date conflict on it.
        if (isAppError(error) && error.code === "VALIDATION") {
          throw new AppError("VALIDATION", BIRTH_YEAR_MESSAGE, {
            details: [{ path: "birthYear", message: BIRTH_YEAR_MESSAGE }],
            cause: error
          });
        }
        throw error;
      }
      // Re-read with the profile join (avatar) inside the same transaction.
      const view = await findPerson(tx, before.id);
      if (view === undefined) throw new AppError("NOT_FOUND", NOT_LINKED_MESSAGE);
      return view;
    });
    return toPersonWithAvatar(app, saved, { id: user.id, role: user.role });
  };

  app.patch("/family/me", selfEditOptions, async (request) => selfEditHandler(authUser(request), request.body, request.ip));
  app.patch("/family/people/me", selfEditOptions, async (request) =>
    selfEditHandler(authUser(request), request.body, request.ip)
  );
};

export default memberFamilyRoutes;
