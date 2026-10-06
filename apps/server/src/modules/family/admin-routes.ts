/**
 * Admin family-tree routes: people CRUD (including linking a person to an
 * account) and relationships. Every mutation is audited inside its
 * transaction with ids and field names only, never names or years.
 */
import {
  AuditAction,
  AuditEntityType,
  apiErrorSchema,
  type CreatePersonInput,
  createPersonInputSchema,
  createRelationshipInputSchema,
  idParamSchema,
  type Person,
  personSchema,
  type Relationship,
  relationshipSchema,
  type UpdatePersonInput,
  updatePersonInputSchema
} from "@cuencada/types";
import { and, eq, isNull } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { people, personRelationships, users } from "../../db/schema/index.js";
import { recordAudit, type Transaction } from "../../lib/audit.js";
import { AppError } from "../../lib/errors.js";
import { authUser } from "../../plugins/auth.js";
import { PgErrorCode, pgErrorInfo } from "./db-errors.js";
import { insertRelationship } from "./relationships.js";
import { findPerson, type PersonRow, personColumns, relationshipColumns, toPerson } from "./repository.js";

const PERSON_NOT_FOUND = "No encontramos a esa persona.";
const RELATIONSHIP_NOT_FOUND = "No encontramos esa relación.";
const USER_ALREADY_LINKED = "Esa cuenta ya está vinculada a otra persona del árbol.";
const USER_NOT_FOUND = "No existe esa cuenta de usuario.";
const LINKED_DELETE = "Esta persona está vinculada a una cuenta. Desvincúlala antes de eliminarla.";
const YEARS_ORDER = "El año de fallecimiento no puede ser anterior al de nacimiento.";
const DEATH_IMPLIES_DECEASED = "Si hay año de fallecimiento, la persona debe marcarse como fallecida.";

/** Audit actions without a well-known `AuditAction` entry. */
const PersonLinkAction = {
  Linked: "person.user_linked",
  Unlinked: "person.user_unlinked"
} as const;

/** Map a failed people insert/update to a client error, or rethrow. */
function mapPersonWriteError(error: unknown): never {
  const info = pgErrorInfo(error);
  if (info?.code === PgErrorCode.UniqueViolation && info.constraint === "people_user_id_unique") {
    throw new AppError("CONFLICT", USER_ALREADY_LINKED, {
      details: [{ path: "userId", message: USER_ALREADY_LINKED }],
      cause: error
    });
  }
  if (info?.code === PgErrorCode.ForeignKeyViolation) {
    throw new AppError("VALIDATION", USER_NOT_FOUND, { details: [{ path: "userId", message: USER_NOT_FOUND }], cause: error });
  }
  if (info?.code === PgErrorCode.CheckViolation) {
    const message = info.constraint === "people_death_implies_deceased_check" ? DEATH_IMPLIES_DECEASED : YEARS_ORDER;
    const path = info.constraint === "people_death_implies_deceased_check" ? "deceased" : "deathYear";
    throw new AppError("VALIDATION", message, { details: [{ path, message }], cause: error });
  }
  throw error;
}

/**
 * Friendly pre-checks for linking `userId` (the unique index and FK remain
 * the backstop for races).
 *
 * @param tx - Open transaction.
 * @param userId - Account to link.
 * @param personId - Person being edited (excluded from the uniqueness check), if any.
 */
async function assertLinkable(tx: Transaction, userId: string, personId: string | undefined): Promise<void> {
  const [user] = await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).limit(1);
  if (user === undefined) {
    throw new AppError("VALIDATION", USER_NOT_FOUND, { details: [{ path: "userId", message: USER_NOT_FOUND }] });
  }
  const [linked] = await tx.select({ id: people.id }).from(people).where(eq(people.userId, userId)).limit(1);
  if (linked !== undefined && linked.id !== personId) {
    throw new AppError("CONFLICT", USER_ALREADY_LINKED, { details: [{ path: "userId", message: USER_ALREADY_LINKED }] });
  }
}

/** `set` values for an admin PATCH: only the keys that were sent. */
function updateValues(input: UpdatePersonInput): Partial<typeof people.$inferInsert> {
  const values: Partial<typeof people.$inferInsert> = {};
  if (input.fullName !== undefined) values.fullName = input.fullName;
  if (input.nickname !== undefined) values.nickname = input.nickname;
  if (input.familyBranch !== undefined) values.familyBranch = input.familyBranch;
  if (input.birthYear !== undefined) values.birthYear = input.birthYear;
  if (input.deathYear !== undefined) values.deathYear = input.deathYear;
  if (input.deceased !== undefined) values.deceased = input.deceased;
  if (input.userId !== undefined) values.userId = input.userId;
  return values;
}

/** Insert values for an admin create. */
function createValues(input: CreatePersonInput, actorUserId: string): typeof people.$inferInsert {
  return {
    fullName: input.fullName,
    nickname: input.nickname,
    familyBranch: input.familyBranch,
    birthYear: input.birthYear,
    deathYear: input.deathYear,
    deceased: input.deceased,
    userId: input.userId,
    createdByUserId: actorUserId
  };
}

/** Record the link/unlink audit entry when `userId` changed. */
async function auditLinkChange(
  tx: Transaction,
  before: PersonRow | undefined,
  after: PersonRow,
  actorUserId: string,
  ip: string
): Promise<void> {
  const previous = before?.userId ?? null;
  if (previous === after.userId) return;
  if (previous !== null) {
    await recordAudit(tx, {
      actorUserId,
      action: PersonLinkAction.Unlinked,
      entityType: AuditEntityType.Person,
      entityId: after.id,
      metadata: { userId: previous },
      ip
    });
  }
  if (after.userId !== null) {
    await recordAudit(tx, {
      actorUserId,
      action: PersonLinkAction.Linked,
      entityType: AuditEntityType.Person,
      entityId: after.id,
      metadata: { userId: after.userId },
      ip
    });
  }
}

/** Admin family routes (mounted under `/api`). */
const adminFamilyRoutes: FastifyPluginAsyncZod = async (app) => {
  /** `POST /api/admin/people`: create a person, optionally linked to an account. */
  app.post(
    "/admin/people",
    {
      config: { auth: "admin" },
      schema: {
        body: createPersonInputSchema,
        response: { 201: personSchema, 400: apiErrorSchema, 409: apiErrorSchema }
      }
    },
    async (request, reply): Promise<Person> => {
      const admin = authUser(request);
      const input = request.body;
      const person = await app.db.transaction(async (tx) => {
        if (input.userId !== null) await assertLinkable(tx, input.userId, undefined);
        let row: PersonRow | undefined;
        try {
          [row] = await tx.insert(people).values(createValues(input, admin.id)).returning(personColumns);
        } catch (error) {
          mapPersonWriteError(error);
        }
        if (row === undefined) throw new Error("person insert returned no row");
        await recordAudit(tx, {
          actorUserId: admin.id,
          action: AuditAction.PersonCreated,
          entityType: AuditEntityType.Person,
          entityId: row.id,
          metadata: { linkedUserId: row.userId },
          ip: request.ip
        });
        await auditLinkChange(tx, undefined, row, admin.id, request.ip);
        return toPerson(row, admin);
      });
      return reply.code(201).send(person);
    }
  );

  /** `PATCH /api/admin/people/:id`: edit fields; `userId` links (unique) or unlinks (`null`). */
  app.patch(
    "/admin/people/:id",
    {
      config: { auth: "admin" },
      schema: {
        params: idParamSchema,
        body: updatePersonInputSchema,
        response: { 200: personSchema, 400: apiErrorSchema, 404: apiErrorSchema, 409: apiErrorSchema }
      }
    },
    async (request): Promise<Person> => {
      const admin = authUser(request);
      const { id } = request.params;
      return app.db.transaction(async (tx) => {
        const before = await findPerson(tx, id);
        if (before === undefined) throw new AppError("NOT_FOUND", PERSON_NOT_FOUND);
        const input = request.body;
        if (input.userId !== undefined && input.userId !== null) await assertLinkable(tx, input.userId, id);
        const values = updateValues(input);
        let row: PersonRow | undefined;
        try {
          [row] = await tx.update(people).set(values).where(eq(people.id, id)).returning(personColumns);
        } catch (error) {
          mapPersonWriteError(error);
        }
        if (row === undefined) throw new AppError("NOT_FOUND", PERSON_NOT_FOUND);
        await recordAudit(tx, {
          actorUserId: admin.id,
          action: AuditAction.PersonUpdated,
          entityType: AuditEntityType.Person,
          entityId: row.id,
          metadata: { fields: Object.keys(values) },
          ip: request.ip
        });
        await auditLinkChange(tx, before, row, admin.id, request.ip);
        return toPerson(row, admin);
      });
    }
  );

  /**
   * `DELETE /api/admin/people/:id`: 409 while linked to an account (unlink
   * first); relationships go with it (FK cascade).
   */
  app.delete(
    "/admin/people/:id",
    {
      config: { auth: "admin" },
      schema: { params: idParamSchema, response: { 204: z.null(), 404: apiErrorSchema, 409: apiErrorSchema } }
    },
    async (request, reply) => {
      const admin = authUser(request);
      const { id } = request.params;
      await app.db.transaction(async (tx) => {
        // One statement: a concurrent link cannot slip between check and delete.
        const [deleted] = await tx
          .delete(people)
          .where(and(eq(people.id, id), isNull(people.userId)))
          .returning({ id: people.id });
        if (deleted === undefined) {
          const existing = await findPerson(tx, id);
          if (existing === undefined) throw new AppError("NOT_FOUND", PERSON_NOT_FOUND);
          throw new AppError("CONFLICT", LINKED_DELETE);
        }
        await recordAudit(tx, {
          actorUserId: admin.id,
          action: AuditAction.PersonDeleted,
          entityType: AuditEntityType.Person,
          entityId: deleted.id,
          ip: request.ip
        });
      });
      return reply.code(204).send(null);
    }
  );

  /** `POST /api/admin/relationships`: cycle-, duplicate- and parent-count-checked under the tree lock. */
  app.post(
    "/admin/relationships",
    {
      config: { auth: "admin" },
      schema: {
        body: createRelationshipInputSchema,
        response: { 201: relationshipSchema, 400: apiErrorSchema, 404: apiErrorSchema, 409: apiErrorSchema }
      }
    },
    async (request, reply): Promise<Relationship> => {
      const admin = authUser(request);
      const relationship = await app.db.transaction(async (tx) => {
        const created = await insertRelationship(tx, request.body, admin.id);
        await recordAudit(tx, {
          actorUserId: admin.id,
          action: AuditAction.RelationshipCreated,
          entityType: AuditEntityType.Relationship,
          entityId: created.id,
          metadata: { kind: created.kind, fromPersonId: created.fromPersonId, toPersonId: created.toPersonId },
          ip: request.ip
        });
        return created;
      });
      return reply.code(201).send(relationship);
    }
  );

  /** `DELETE /api/admin/relationships/:id`. */
  app.delete(
    "/admin/relationships/:id",
    {
      config: { auth: "admin" },
      schema: { params: idParamSchema, response: { 204: z.null(), 404: apiErrorSchema } }
    },
    async (request, reply) => {
      const admin = authUser(request);
      await app.db.transaction(async (tx) => {
        const [deleted] = await tx
          .delete(personRelationships)
          .where(eq(personRelationships.id, request.params.id))
          .returning(relationshipColumns);
        if (deleted === undefined) throw new AppError("NOT_FOUND", RELATIONSHIP_NOT_FOUND);
        await recordAudit(tx, {
          actorUserId: admin.id,
          action: AuditAction.RelationshipDeleted,
          entityType: AuditEntityType.Relationship,
          entityId: deleted.id,
          metadata: { kind: deleted.kind, fromPersonId: deleted.fromPersonId, toPersonId: deleted.toPersonId },
          ip: request.ip
        });
      });
      return reply.code(204).send(null);
    }
  );
};

export default adminFamilyRoutes;
