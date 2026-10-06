/**
 * Public and member reads of Cuencada editions:
 * `GET /cuencadas`, `/cuencadas/home`, `/cuencadas/:year`, `/cuencadas/:year/members`.
 *
 * Privacy: anonymous responses are built from public-only items and go
 * through `publicCuencadaSchema`, which has no member-only fields; the
 * response schema strips anything else as a second guard.
 */
import {
  apiErrorSchema,
  type CuencadaHome,
  type CuencadaSummary,
  cuencadaHomeSchema,
  cuencadaSummarySchema,
  type MemberCuencadaDetails,
  memberCuencadaDetailsSchema,
  type PublicCuencada,
  publicCuencadaSchema,
  Visibility,
  yearParamSchema
} from "@cuencada/types";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { DbOrTx } from "../../lib/audit.js";
import { toAnnouncement } from "../announcements/repository.js";
import {
  type CuencadaRow,
  toCuencadaSummary,
  toDailyMessage,
  toItineraryItem,
  toLocationItem,
  toPublicCuencada
} from "./mappers.js";
import {
  ContentScope,
  findDailyMessage,
  getPublishedByYear,
  listPortalAnnouncements,
  listPublishedEditions,
  loadEditionContent
} from "./repository.js";
import { computeCuencadaStatus, localDateInZone, selectHome } from "./status.js";

/**
 * Build the anonymous view of one published edition: public items, live
 * public announcements and today's message in the edition's timezone.
 *
 * @param db - Client.
 * @param row - A published edition.
 * @param now - Current instant.
 */
export async function buildPublicCuencada(db: DbOrTx, row: CuencadaRow, now: Date): Promise<PublicCuencada> {
  const [contentById, today] = await Promise.all([
    loadEditionContent(db, [row.id], ContentScope.Public, now),
    findDailyMessage(db, row.id, localDateInZone(now, row.timezone))
  ]);
  const content = contentById.get(row.id);
  return toPublicCuencada(
    row,
    {
      itinerary: (content?.itinerary ?? []).map(toItineraryItem),
      locations: (content?.locations ?? []).map(toLocationItem),
      announcements: (content?.announcements ?? []).map(toAnnouncement),
      todayMessage: today === undefined ? null : toDailyMessage(today)
    },
    now
  );
}

/** Public/member Cuencada reads under `/api`. */
const cuencadaPublicRoutes: FastifyPluginAsyncZod = async (app) => {
  /** `GET /api/cuencadas`: published editions, newest first. */
  app.get(
    "/cuencadas",
    { config: { auth: "public" }, schema: { response: { 200: z.array(cuencadaSummarySchema) } } },
    async (): Promise<CuencadaSummary[]> => {
      const now = app.clock.now();
      const editions = await listPublishedEditions(app.db);
      return editions.map(({ row, hasMedia }) => toCuencadaSummary(row, hasMedia, now));
    }
  );

  /** `GET /api/cuencadas/home`: featured edition (active, else upcoming), latest past and portal-wide public announcements. */
  app.get(
    "/cuencadas/home",
    { config: { auth: "public" }, schema: { response: { 200: cuencadaHomeSchema } } },
    async (): Promise<CuencadaHome> => {
      const now = app.clock.now();
      const [editions, portal] = await Promise.all([
        listPublishedEditions(app.db),
        listPortalAnnouncements(app.db, [Visibility.Public], now)
      ]);
      const candidates = editions.map((edition) => ({
        ...edition,
        status: computeCuencadaStatus(edition.row, now),
        startsAt: edition.row.startsAt,
        endsAt: edition.row.endsAt
      }));
      const selection = selectHome(candidates);
      return {
        mode: selection.mode,
        featured: selection.featured === null ? null : await buildPublicCuencada(app.db, selection.featured.row, now),
        latestPast:
          selection.latestPast === null
            ? null
            : toCuencadaSummary(selection.latestPast.row, selection.latestPast.hasMedia, now),
        announcements: portal.map(toAnnouncement)
      };
    }
  );

  /** `GET /api/cuencadas/:year`: anonymous view; drafts answer 404. */
  app.get(
    "/cuencadas/:year",
    {
      config: { auth: "public" },
      schema: { params: yearParamSchema, response: { 200: publicCuencadaSchema, 404: apiErrorSchema } }
    },
    async (request): Promise<PublicCuencada> => {
      const now = app.clock.now();
      const row = await getPublishedByYear(app.db, request.params.year);
      return buildPublicCuencada(app.db, row, now);
    }
  );

  /** `GET /api/cuencadas/:year/members`: member-only links and every item/announcement. */
  app.get(
    "/cuencadas/:year/members",
    {
      config: { auth: "user" },
      schema: { params: yearParamSchema, response: { 200: memberCuencadaDetailsSchema, 404: apiErrorSchema } }
    },
    async (request): Promise<MemberCuencadaDetails> => {
      const now = app.clock.now();
      const row = await getPublishedByYear(app.db, request.params.year);
      const content = (await loadEditionContent(app.db, [row.id], ContentScope.Members, now)).get(row.id);
      return {
        cuencadaId: row.id,
        year: row.year,
        itinerary: (content?.itinerary ?? []).map(toItineraryItem),
        locations: (content?.locations ?? []).map(toLocationItem),
        announcements: (content?.announcements ?? []).map(toAnnouncement),
        whatsappUrl: row.whatsappUrl,
        externalAlbumUrl: row.externalAlbumUrl
      };
    }
  );
};

export default cuencadaPublicRoutes;
