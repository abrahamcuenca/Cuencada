/**
 * Admin CRUD and reordering for an edition's itinerary items and locations.
 *
 * Integrity rules enforced here (the DB cannot express them in 0001):
 * - an itinerary `locationId` must belong to the **same** Cuencada (→ 400);
 * - PATCH re-validates the merged row (`endTime > startTime`, lat/lng pair);
 * - reorder lists every item exactly once and rewrites `sort_order` in one
 *   statement inside a transaction.
 */
import {
  AuditAction,
  AuditEntityType,
  apiErrorSchema,
  createItineraryItemInputSchema,
  createLocationInputSchema,
  type ItineraryItem,
  idParamSchema,
  itineraryItemSchema,
  type LocationItem,
  locationItemSchema,
  reorderInputSchema,
  updateItineraryItemInputSchema,
  updateLocationInputSchema
} from "@cuencada/types";
import { and, asc, eq, sql } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { cuencadaItineraryItems, cuencadaLocations } from "../../db/schema/index.js";
import { type DbOrTx, recordAudit } from "../../lib/audit.js";
import { AppError } from "../../lib/errors.js";
import { authUser } from "../../plugins/auth.js";
import { type ItineraryRow, type LocationRow, toItineraryItem, toLocationItem } from "./mappers.js";
import { getCuencadaById, nextSortOrder, rewriteSortOrder } from "./repository.js";

const ITEM_NOT_FOUND = "No encontramos esa actividad.";
const LOCATION_NOT_FOUND = "No encontramos ese lugar.";

/**
 * Reject a `locationId` that does not exist or belongs to another Cuencada.
 *
 * @param db - Transaction.
 * @param locationId - Requested location, or `null` (always fine).
 * @param cuencadaId - The item's edition.
 * @throws AppError `VALIDATION` on `locationId`.
 */
async function assertLocationInCuencada(db: DbOrTx, locationId: string | null, cuencadaId: string): Promise<void> {
  if (locationId === null) return;
  const [found] = await db
    .select({ id: cuencadaLocations.id })
    .from(cuencadaLocations)
    .where(and(eq(cuencadaLocations.id, locationId), eq(cuencadaLocations.cuencadaId, cuencadaId)))
    .limit(1);
  if (found === undefined) {
    const message = "El lugar no pertenece a esta Cuencada.";
    throw new AppError("VALIDATION", message, { details: [{ path: "locationId", message }] });
  }
}

/** `HH:MM[:SS]` → `HH:MM` so merged values compare like the contract's. */
function hhmm(value: string | null): string | null {
  return value === null ? null : value.slice(0, 5);
}

/** `endTime > startTime` on the merged row. */
function assertTimeOrder(startTime: string | null, endTime: string | null): void {
  if (startTime !== null && endTime !== null && endTime <= startTime) {
    const message = "La hora de fin debe ser posterior a la de inicio.";
    throw new AppError("VALIDATION", message, { details: [{ path: "endTime", message }] });
  }
}

/** lat/lng both set or both null on the merged row. */
function assertLatLngPair(lat: number | null, lng: number | null): void {
  if ((lat === null) !== (lng === null)) {
    const message = "Latitud y longitud van juntas.";
    throw new AppError("VALIDATION", message, { details: [{ path: "lng", message }] });
  }
}

/** Only the keys that were sent (drizzle would also skip `undefined`, but this keeps the types exact). */
function definedOnly<TInput extends Record<string, unknown>>(input: TInput): Partial<TInput> {
  const values: Partial<TInput> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) Object.assign(values, { [key]: value });
  }
  return values;
}

async function listItinerary(db: DbOrTx, cuencadaId: string): Promise<ItineraryRow[]> {
  return db
    .select()
    .from(cuencadaItineraryItems)
    .where(eq(cuencadaItineraryItems.cuencadaId, cuencadaId))
    .orderBy(asc(cuencadaItineraryItems.sortOrder), asc(cuencadaItineraryItems.id));
}

async function listLocations(db: DbOrTx, cuencadaId: string): Promise<LocationRow[]> {
  return db
    .select()
    .from(cuencadaLocations)
    .where(eq(cuencadaLocations.cuencadaId, cuencadaId))
    .orderBy(asc(cuencadaLocations.sortOrder), asc(cuencadaLocations.id));
}

/** Lock and return an itinerary item, or 404. */
async function lockItineraryItem(db: DbOrTx, id: string): Promise<ItineraryRow> {
  const [row] = await db.select().from(cuencadaItineraryItems).where(eq(cuencadaItineraryItems.id, id)).for("update");
  if (row === undefined) throw new AppError("NOT_FOUND", ITEM_NOT_FOUND);
  return row;
}

/** Lock and return a location, or 404. */
async function lockLocation(db: DbOrTx, id: string): Promise<LocationRow> {
  const [row] = await db.select().from(cuencadaLocations).where(eq(cuencadaLocations.id, id)).for("update");
  if (row === undefined) throw new AppError("NOT_FOUND", LOCATION_NOT_FOUND);
  return row;
}

const errorResponses = { 404: apiErrorSchema };

/** Admin itinerary and location routes under `/api`. */
const cuencadaContentRoutes: FastifyPluginAsyncZod = async (app) => {
  /* ------------------------------ Itinerary ------------------------------ */

  /** `POST /api/admin/cuencadas/:id/itinerary`: append an item. */
  app.post(
    "/admin/cuencadas/:id/itinerary",
    {
      config: { auth: "admin" },
      schema: { params: idParamSchema, body: createItineraryItemInputSchema, response: { 201: itineraryItemSchema, ...errorResponses } }
    },
    async (request, reply) => {
      const admin = authUser(request);
      const input = request.body;
      const row = await app.db.transaction(async (tx) => {
        const cuencada = await getCuencadaById(tx, request.params.id, true);
        await assertLocationInCuencada(tx, input.locationId, cuencada.id);
        const sortOrder = await nextSortOrder(tx, cuencadaItineraryItems, cuencada.id);
        const [created] = await tx
          .insert(cuencadaItineraryItems)
          .values({ ...input, cuencadaId: cuencada.id, sortOrder })
          .returning();
        if (created === undefined) throw new Error("create itinerary item: insert returned no row");
        await recordAudit(tx, {
          actorUserId: admin.id,
          action: AuditAction.ItineraryItemCreated,
          entityType: AuditEntityType.ItineraryItem,
          entityId: created.id,
          metadata: { cuencadaId: cuencada.id, date: created.date },
          ip: request.ip
        });
        return created;
      });
      return reply.code(201).send(toItineraryItem(row));
    }
  );

  /** `PUT /api/admin/cuencadas/:id/itinerary/order`: full new order. */
  app.put(
    "/admin/cuencadas/:id/itinerary/order",
    {
      config: { auth: "admin" },
      schema: { params: idParamSchema, body: reorderInputSchema, response: { 200: z.array(itineraryItemSchema), ...errorResponses } }
    },
    async (request): Promise<ItineraryItem[]> => {
      const admin = authUser(request);
      const rows = await app.db.transaction(async (tx) => {
        const cuencada = await getCuencadaById(tx, request.params.id, true);
        await rewriteSortOrder(tx, cuencadaItineraryItems, cuencada.id, request.body.ids, app.clock.now());
        await recordAudit(tx, {
          actorUserId: admin.id,
          action: AuditAction.ItineraryReordered,
          entityType: AuditEntityType.Cuencada,
          entityId: cuencada.id,
          metadata: { count: request.body.ids.length },
          ip: request.ip
        });
        return listItinerary(tx, cuencada.id);
      });
      return rows.map(toItineraryItem);
    }
  );

  /** `PATCH /api/admin/itinerary/:id`. */
  app.patch(
    "/admin/itinerary/:id",
    {
      config: { auth: "admin" },
      schema: { params: idParamSchema, body: updateItineraryItemInputSchema, response: { 200: itineraryItemSchema, ...errorResponses } }
    },
    async (request): Promise<ItineraryItem> => {
      const admin = authUser(request);
      const input = request.body;
      const row = await app.db.transaction(async (tx) => {
        const current = await lockItineraryItem(tx, request.params.id);
        const startTime = input.startTime === undefined ? hhmm(current.startTime) : input.startTime;
        const endTime = input.endTime === undefined ? hhmm(current.endTime) : input.endTime;
        assertTimeOrder(startTime, endTime);
        if (input.locationId !== undefined) await assertLocationInCuencada(tx, input.locationId, current.cuencadaId);
        const [updated] = await tx
          .update(cuencadaItineraryItems)
          .set(definedOnly(input))
          .where(eq(cuencadaItineraryItems.id, current.id))
          .returning();
        if (updated === undefined) throw new AppError("NOT_FOUND", ITEM_NOT_FOUND);
        await recordAudit(tx, {
          actorUserId: admin.id,
          action: AuditAction.ItineraryItemUpdated,
          entityType: AuditEntityType.ItineraryItem,
          entityId: updated.id,
          metadata: { cuencadaId: updated.cuencadaId, fields: Object.keys(input) },
          ip: request.ip
        });
        return updated;
      });
      return toItineraryItem(row);
    }
  );

  /** `DELETE /api/admin/itinerary/:id`. */
  app.delete(
    "/admin/itinerary/:id",
    { config: { auth: "admin" }, schema: { params: idParamSchema, response: { 204: z.null(), ...errorResponses } } },
    async (request, reply) => {
      const admin = authUser(request);
      await app.db.transaction(async (tx) => {
        const current = await lockItineraryItem(tx, request.params.id);
        await tx.delete(cuencadaItineraryItems).where(eq(cuencadaItineraryItems.id, current.id));
        await recordAudit(tx, {
          actorUserId: admin.id,
          action: AuditAction.ItineraryItemDeleted,
          entityType: AuditEntityType.ItineraryItem,
          entityId: current.id,
          metadata: { cuencadaId: current.cuencadaId, title: current.title },
          ip: request.ip
        });
      });
      return reply.code(204).send(null);
    }
  );

  /* ------------------------------ Locations ------------------------------ */

  /** `POST /api/admin/cuencadas/:id/locations`: append a location. */
  app.post(
    "/admin/cuencadas/:id/locations",
    {
      config: { auth: "admin" },
      schema: { params: idParamSchema, body: createLocationInputSchema, response: { 201: locationItemSchema, ...errorResponses } }
    },
    async (request, reply) => {
      const admin = authUser(request);
      const row = await app.db.transaction(async (tx) => {
        const cuencada = await getCuencadaById(tx, request.params.id, true);
        const sortOrder = await nextSortOrder(tx, cuencadaLocations, cuencada.id);
        const [created] = await tx
          .insert(cuencadaLocations)
          .values({ ...request.body, cuencadaId: cuencada.id, sortOrder })
          .returning();
        if (created === undefined) throw new Error("create location: insert returned no row");
        await recordAudit(tx, {
          actorUserId: admin.id,
          action: AuditAction.LocationCreated,
          entityType: AuditEntityType.Location,
          entityId: created.id,
          metadata: { cuencadaId: cuencada.id, name: created.name },
          ip: request.ip
        });
        return created;
      });
      return reply.code(201).send(toLocationItem(row));
    }
  );

  /** `PUT /api/admin/cuencadas/:id/locations/order`: full new order. */
  app.put(
    "/admin/cuencadas/:id/locations/order",
    {
      config: { auth: "admin" },
      schema: { params: idParamSchema, body: reorderInputSchema, response: { 200: z.array(locationItemSchema), ...errorResponses } }
    },
    async (request): Promise<LocationItem[]> => {
      const admin = authUser(request);
      const rows = await app.db.transaction(async (tx) => {
        const cuencada = await getCuencadaById(tx, request.params.id, true);
        await rewriteSortOrder(tx, cuencadaLocations, cuencada.id, request.body.ids, app.clock.now());
        await recordAudit(tx, {
          actorUserId: admin.id,
          action: AuditAction.LocationsReordered,
          entityType: AuditEntityType.Cuencada,
          entityId: cuencada.id,
          metadata: { count: request.body.ids.length },
          ip: request.ip
        });
        return listLocations(tx, cuencada.id);
      });
      return rows.map(toLocationItem);
    }
  );

  /** `PATCH /api/admin/locations/:id`. */
  app.patch(
    "/admin/locations/:id",
    {
      config: { auth: "admin" },
      schema: { params: idParamSchema, body: updateLocationInputSchema, response: { 200: locationItemSchema, ...errorResponses } }
    },
    async (request): Promise<LocationItem> => {
      const admin = authUser(request);
      const input = request.body;
      const row = await app.db.transaction(async (tx) => {
        const current = await lockLocation(tx, request.params.id);
        assertLatLngPair(input.lat === undefined ? current.lat : input.lat, input.lng === undefined ? current.lng : input.lng);
        const [updated] = await tx
          .update(cuencadaLocations)
          .set(definedOnly(input))
          .where(eq(cuencadaLocations.id, current.id))
          .returning();
        if (updated === undefined) throw new AppError("NOT_FOUND", LOCATION_NOT_FOUND);
        await recordAudit(tx, {
          actorUserId: admin.id,
          action: AuditAction.LocationUpdated,
          entityType: AuditEntityType.Location,
          entityId: updated.id,
          metadata: { cuencadaId: updated.cuencadaId, fields: Object.keys(input) },
          ip: request.ip
        });
        return updated;
      });
      return toLocationItem(row);
    }
  );

  /** `DELETE /api/admin/locations/:id` (itinerary links are set to null by the FK). */
  app.delete(
    "/admin/locations/:id",
    { config: { auth: "admin" }, schema: { params: idParamSchema, response: { 204: z.null(), ...errorResponses } } },
    async (request, reply) => {
      const admin = authUser(request);
      await app.db.transaction(async (tx) => {
        const current = await lockLocation(tx, request.params.id);
        const unlinked = await tx
          .update(cuencadaItineraryItems)
          .set({ locationId: null, updatedAt: app.clock.now() })
          .where(eq(cuencadaItineraryItems.locationId, current.id))
          .returning({ id: cuencadaItineraryItems.id });
        await tx.delete(cuencadaLocations).where(eq(cuencadaLocations.id, current.id));
        await recordAudit(tx, {
          actorUserId: admin.id,
          action: AuditAction.LocationDeleted,
          entityType: AuditEntityType.Location,
          entityId: current.id,
          metadata: { cuencadaId: current.cuencadaId, name: current.name, unlinkedItineraryItems: unlinked.length },
          ip: request.ip
        });
      });
      return reply.code(204).send(null);
    }
  );
};

export default cuencadaContentRoutes;
