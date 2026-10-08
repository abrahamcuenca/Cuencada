/**
 * Admin family-tree routes: people CRUD (including linking a person to an
 * account and attaching a new person with `relateTo`) and relationships.
 * Every mutation writes, inside its transaction, a `person_revisions` row
 * (admin undo history) and an audit row with ids and field names only,
 * never names, dates or years. Admins have full scope (no circle).
 */
import {
  type AdminUpdatePersonInput,
  adminCreatePersonInputSchema,
  adminDeletePersonQuerySchema,
  adminUpdatePersonInputSchema,
  apiErrorSchema,
  AuditEntityType,
  createRelationshipInputSchema,
  idParamSchema,
  type Person,
  personSchema,
  type Relationship,
  relationshipSchema
} from "@cuencada/types";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { recordAudit } from "../../lib/audit.js";
import { AppError } from "../../lib/errors.js";
import { authUser } from "../../plugins/auth.js";
import { deletePersonPhotoObjects, personPhotoObjectKeys } from "./personPhotoObjects.js";
import { findPerson, type PersonViewRow, toPersonWithAvatar } from "./repository.js";
import { purgePersonRevisions } from "./revisions.js";
import {
  FamilyAuditAction,
  PERSON_NOT_FOUND,
  type PersonPatch,
  createPersonTx,
  createRelationshipTx,
  deletePersonTx,
  deleteRelationshipTx,
  lockPersonRow,
  updatePersonTx
} from "./writes.js";
import type { Transaction } from "../../lib/audit.js";

const RELATIONSHIP_NOT_FOUND = "No encontramos esa relación.";
const LINKED_DELETE = "Esta persona está vinculada a una cuenta. Desvincúlala antes de eliminarla.";

/** The keys of an admin PATCH that were sent or derived. */
function adminPatch(input: AdminUpdatePersonInput): PersonPatch {
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
  if (input.userId !== undefined) patch.userId = input.userId;
  return patch;
}

/**
 * Re-read a just-written person with the profile/account join (for the
 * avatar), inside the write's transaction.
 *
 * @throws Error when the row vanished (cannot happen inside the transaction).
 */
async function viewOf(tx: Transaction, id: string): Promise<PersonViewRow> {
  const view = await findPerson(tx, id);
  if (view === undefined) throw new Error("person vanished inside its write transaction");
  return view;
}

/** Admin family routes (mounted under `/api`). */
const adminFamilyRoutes: FastifyPluginAsyncZod = async (app) => {
  /** `POST /api/admin/people`: create a person, optionally linked to an account and related to someone (`relateTo`). */
  app.post(
    "/admin/people",
    {
      config: { auth: "admin" },
      schema: {
        body: adminCreatePersonInputSchema,
        response: { 201: personSchema, 400: apiErrorSchema, 404: apiErrorSchema, 409: apiErrorSchema }
      }
    },
    async (request, reply): Promise<Person> => {
      const admin = authUser(request);
      const { relateTo, ...values } = request.body;
      const person = await app.db.transaction(async (tx) => {
        const { row } = await createPersonTx(tx, {
          values,
          relateTo: relateTo === null ? null : { personId: relateTo.personId.toLowerCase(), kind: relateTo.kind },
          actor: { id: admin.id, ip: request.ip },
          member: false
        });
        return viewOf(tx, row.id);
      });
      return reply.code(201).send(await toPersonWithAvatar(app, person, admin));
    }
  );

  /** `PATCH /api/admin/people/:id`: edit fields (merged dates re-checked); `userId` links (unique) or unlinks (`null`). */
  app.patch(
    "/admin/people/:id",
    {
      config: { auth: "admin" },
      schema: {
        params: idParamSchema,
        body: adminUpdatePersonInputSchema,
        response: { 200: personSchema, 400: apiErrorSchema, 404: apiErrorSchema, 409: apiErrorSchema }
      }
    },
    async (request): Promise<Person> => {
      const admin = authUser(request);
      const { id } = request.params;
      const saved = await app.db.transaction(async (tx) => {
        const before = await lockPersonRow(tx, id);
        if (before === undefined) throw new AppError("NOT_FOUND", PERSON_NOT_FOUND);
        const row = await updatePersonTx(tx, before, adminPatch(request.body), { id: admin.id, ip: request.ip });
        return viewOf(tx, row.id);
      });
      return toPersonWithAvatar(app, saved, admin);
    }
  );

  /**
   * `DELETE /api/admin/people/:id[?purgeHistory=true]`: 409 while linked to an
   * account (unlink first). Relationships go with it (recorded as revisions),
   * and so do the tree-photo objects in the bucket (current derivatives and
   * pending uploads, deleted after the commit). `purgeHistory` erases the
   * person's history first and records nothing about the delete.
   */
  app.delete(
    "/admin/people/:id",
    {
      config: { auth: "admin" },
      schema: {
        params: idParamSchema,
        querystring: adminDeletePersonQuerySchema,
        response: { 204: z.null(), 400: apiErrorSchema, 404: apiErrorSchema, 409: apiErrorSchema }
      }
    },
    async (request, reply) => {
      const admin = authUser(request);
      const id = request.params.id.toLowerCase();
      const { purgeHistory } = request.query;
      const keys = await app.db.transaction(async (tx) => {
        // Locked: a concurrent link cannot slip between check and delete.
        const row = await lockPersonRow(tx, id);
        const view = row === undefined ? undefined : await findPerson(tx, id);
        if (row === undefined || view === undefined) throw new AppError("NOT_FOUND", PERSON_NOT_FOUND);
        if (row.userId !== null) throw new AppError("CONFLICT", LINKED_DELETE);
        const photoKeys = await personPhotoObjectKeys(tx, id, view.photoKey);
        if (purgeHistory) {
          const deleted = await purgePersonRevisions(tx, id);
          await recordAudit(tx, {
            actorUserId: admin.id,
            action: FamilyAuditAction.RevisionsPurged,
            entityType: AuditEntityType.Person,
            entityId: id,
            metadata: { deleted, withPersonDelete: true },
            ip: request.ip
          });
        }
        await deletePersonTx(tx, row, { id: admin.id, ip: request.ip }, { recordRevisions: !purgeHistory });
        return photoKeys;
      });
      await deletePersonPhotoObjects(app, id, keys);
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
      const relationship = await app.db.transaction(async (tx) =>
        createRelationshipTx(tx, request.body, { id: admin.id, ip: request.ip })
      );
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
        const deleted = await deleteRelationshipTx(tx, request.params.id, { id: admin.id, ip: request.ip });
        if (deleted === undefined) throw new AppError("NOT_FOUND", RELATIONSHIP_NOT_FOUND);
      });
      return reply.code(204).send(null);
    }
  );
};

export default adminFamilyRoutes;
