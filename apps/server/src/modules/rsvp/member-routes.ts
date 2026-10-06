/**
 * Member RSVP routes:
 * `GET`/`PUT /cuencadas/:year/rsvp/me`, `GET /cuencadas/:year/rsvp/summary`
 * and `GET /cuencadas/:year/attendees` (verified email only).
 *
 * Drafts and unknown years answer 404 (same as the edition pages).
 */
import {
  type ApiErrorDetail,
  type Attendee,
  AuditAction,
  AuditEntityType,
  apiErrorSchema,
  attendeeSchema,
  type MyRsvp,
  type MyRsvpResponse,
  myRsvpResponseSchema,
  myRsvpSchema,
  type RsvpSummary,
  rsvpSummarySchema,
  upsertRsvpInputSchema,
  yearParamSchema
} from "@cuencada/types";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { recordAudit } from "../../lib/audit.js";
import { AppError } from "../../lib/errors.js";
import { rateLimitByIp } from "../../lib/rateLimit.js";
import { authUser } from "../../plugins/auth.js";
import { getPublishedByYear } from "../cuencadas/repository.js";
import { mergeAttendees, toAttendees } from "./attendees.js";
import {
  attendanceCandidates,
  findLocation,
  findRsvp,
  isHotelOf,
  type RsvpRow,
  rsvpHotelCounts,
  rsvpSummaryCounts,
  upsertRsvp,
  yesRsvpCandidates
} from "./repository.js";
import { RSVP_CLOSED_MESSAGES, rsvpDateProblems, rsvpDateWindow, rsvpEditability } from "./rules.js";

const HOTEL_INVALID = "Elige un hotel de esta Cuencada.";

/** Map a stored RSVP to the contract. */
function toMyRsvp(row: RsvpRow): MyRsvp {
  return {
    cuencadaId: row.cuencadaId,
    status: row.status,
    guestCount: row.guestCount,
    arrivalDate: row.arrivalDate,
    departureDate: row.departureDate,
    hotelLocationId: row.hotelLocationId,
    notes: row.notes,
    updatedAt: row.updatedAt.toISOString()
  };
}

/** Member RSVP routes under `/api`. */
const rsvpMemberRoutes: FastifyPluginAsyncZod = async (app) => {
  /** `GET /api/cuencadas/:year/rsvp/me`: the caller's RSVP, the deadline and whether it can still change. */
  app.get(
    "/cuencadas/:year/rsvp/me",
    {
      config: { auth: "user" },
      schema: {
        params: yearParamSchema,
        response: { 200: myRsvpResponseSchema, 404: apiErrorSchema }
      }
    },
    async (request): Promise<MyRsvpResponse> => {
      const user = authUser(request);
      const edition = await getPublishedByYear(app.db, request.params.year);
      const row = await findRsvp(app.db, edition.id, user.id);
      return {
        rsvp: row === undefined ? null : toMyRsvp(row),
        deadline: edition.rsvpDeadline?.toISOString() ?? null,
        editable: rsvpEditability(edition, app.clock.now()).editable
      };
    }
  );

  /**
   * `PUT /api/cuencadas/:year/rsvp/me`: create or replace the caller's RSVP.
   * 409 when the edition is past or the deadline day is over (edition's
   * timezone); 400 for a hotel that is not a `hotel` of this edition or
   * dates outside the stay window.
   */
  app.put(
    "/cuencadas/:year/rsvp/me",
    {
      config: {
        auth: "user",
        rateLimit: rateLimitByIp({ max: 30, timeWindow: "1 minute" })
      },
      schema: {
        params: yearParamSchema,
        body: upsertRsvpInputSchema,
        response: {
          200: myRsvpSchema,
          400: apiErrorSchema,
          404: apiErrorSchema,
          409: apiErrorSchema
        }
      }
    },
    async (request): Promise<MyRsvp> => {
      const user = authUser(request);
      const input = request.body;
      const now = app.clock.now();
      return app.db.transaction(async (tx) => {
        const edition = await getPublishedByYear(tx, request.params.year);
        const editability = rsvpEditability(edition, now);
        if (!editability.editable) throw new AppError("CONFLICT", RSVP_CLOSED_MESSAGES[editability.reason]);

        const problems: ApiErrorDetail[] = rsvpDateProblems(input, rsvpDateWindow(edition));
        if (input.hotelLocationId !== null) {
          const hotel = await findLocation(tx, input.hotelLocationId);
          if (!isHotelOf(hotel, edition.id)) problems.push({ path: "hotelLocationId", message: HOTEL_INVALID });
        }
        if (problems.length > 0) {
          throw new AppError("VALIDATION", problems[0]?.message, {
            details: problems
          });
        }

        const { row, created } = await upsertRsvp(
          tx,
          {
            cuencadaId: edition.id,
            userId: user.id,
            status: input.status,
            guestCount: input.guestCount,
            arrivalDate: input.arrivalDate,
            departureDate: input.departureDate,
            hotelLocationId: input.hotelLocationId,
            notes: input.notes
          },
          now
        );
        // Notes and dates are personal; the audit keeps only the shape of the change.
        await recordAudit(tx, {
          actorUserId: user.id,
          action: AuditAction.RsvpSaved,
          entityType: AuditEntityType.Rsvp,
          entityId: row.id,
          metadata: {
            cuencadaId: edition.id,
            status: row.status,
            guestCount: row.guestCount,
            created
          },
          ip: request.ip
        });
        return toMyRsvp(row);
      });
    }
  );

  /** `GET /api/cuencadas/:year/rsvp/summary`: counts by status, expected people and people per hotel (no names). */
  app.get(
    "/cuencadas/:year/rsvp/summary",
    {
      config: { auth: "user" },
      schema: {
        params: yearParamSchema,
        response: { 200: rsvpSummarySchema, 404: apiErrorSchema }
      }
    },
    async (request): Promise<RsvpSummary> => {
      const edition = await getPublishedByYear(app.db, request.params.year);
      const [counts, byHotel] = await Promise.all([
        rsvpSummaryCounts(app.db, edition.id),
        rsvpHotelCounts(app.db, edition.id)
      ]);
      return { cuencadaId: edition.id, ...counts, byHotel };
    }
  );

  /**
   * `GET /api/cuencadas/:year/attendees`: `yes` RSVPs ∪ historical
   * attendance, deduplicated by person. Verified members only (ADR 0001):
   * it reveals who is part of the family.
   */
  app.get(
    "/cuencadas/:year/attendees",
    {
      config: { auth: "user", requireVerifiedEmail: true },
      schema: {
        params: yearParamSchema,
        response: { 200: z.array(attendeeSchema), 404: apiErrorSchema }
      }
    },
    async (request): Promise<Attendee[]> => {
      const user = authUser(request);
      const edition = await getPublishedByYear(app.db, request.params.year);
      const [rsvps, attendance] = await Promise.all([
        yesRsvpCandidates(app.db, edition.id),
        attendanceCandidates(app.db, edition.id)
      ]);
      return toAttendees(mergeAttendees(rsvps, attendance), user.id, app.storage, request.log);
    }
  );
};

export default rsvpMemberRoutes;
