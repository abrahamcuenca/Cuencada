/**
 * Admin dashboard summary: every counter is computed in one SQL statement.
 */
import { type AdminSummary, adminSummarySchema, apiErrorSchema } from "@cuencada/types";
import { type SQL, sql } from "drizzle-orm";
import { cuencadaRsvps, cuencadas, invites, mediaItems, mediaReports, users } from "../../db/schema/index.js";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { DbOrTx } from "../../lib/audit.js";

/** Row shape returned by {@link loadAdminSummary}'s query (validated, never trusted). */
const summaryRowSchema = z.object({
  users_active: z.number(),
  users_disabled: z.number(),
  users_unverified: z.number(),
  active_admins: z.number(),
  invites_pending: z.number(),
  media_pending_review: z.number(),
  media_reported: z.number(),
  edition_id: z.string().nullable(),
  edition_year: z.number().nullable(),
  edition_title: z.string().nullable(),
  edition_starts_at: z.union([z.date(), z.string()]).nullable(),
  rsvp_yes: z.number(),
  rsvp_maybe: z.number(),
  rsvp_no: z.number(),
  rsvp_guests: z.number()
});

/**
 * Dashboard counters.
 *
 * - Users: active / disabled, active accounts with no verified email, active admins.
 * - Invites: pending and not yet expired.
 * - Media (live, upload started): `pending_review`, and items with a report
 *   newer than their last moderation (i.e. still needing a look).
 * - The earliest published edition that has not ended, with its RSVP counts.
 *
 * @param db - Client or transaction.
 * @param now - Current time.
 */
export async function loadAdminSummary(db: DbOrTx, now: Date): Promise<AdminSummary> {
  const at = now.toISOString();
  // Table and column names come from the Drizzle schema, so a rename breaks the build, not production.
  // `edition` is a CTE; its columns are referenced through the alias `e`.
  const rsvpCount = (status: "yes" | "maybe" | "no"): SQL =>
    sql`coalesce((select count(*) from ${cuencadaRsvps}
      where ${cuencadaRsvps.cuencadaId} = e.id and ${cuencadaRsvps.status} = ${status}), 0)::int`;
  const result = await db.execute(sql`
    with edition as (
      select ${cuencadas.id} as id, ${cuencadas.year} as year, ${cuencadas.title} as title, ${cuencadas.startsAt} as starts_at
      from ${cuencadas}
      where ${cuencadas.isPublished} and ${cuencadas.endsAt} > ${at}::timestamptz
      order by ${cuencadas.startsAt} asc, ${cuencadas.id} asc
      limit 1
    )
    select
      (select count(*) from ${users} where ${users.status} = 'active')::int as users_active,
      (select count(*) from ${users} where ${users.status} = 'disabled')::int as users_disabled,
      (select count(*) from ${users} where ${users.status} = 'active' and ${users.emailVerifiedAt} is null)::int as users_unverified,
      (select count(*) from ${users} where ${users.status} = 'active' and ${users.role} = 'admin')::int as active_admins,
      (select count(*) from ${invites}
         where ${invites.status} = 'pending' and ${invites.expiresAt} > ${at}::timestamptz)::int as invites_pending,
      (select count(*) from ${mediaItems}
         where ${mediaItems.deletedAt} is null and ${mediaItems.uploadStatus} <> 'pending_upload'
           and ${mediaItems.moderationStatus} = 'pending_review')::int as media_pending_review,
      (select count(*) from ${mediaItems}
         where ${mediaItems.deletedAt} is null and ${mediaItems.uploadStatus} <> 'pending_upload'
           and exists (select 1 from ${mediaReports}
                       where ${mediaReports.mediaId} = ${mediaItems.id}
                         and ${mediaReports.createdAt} > coalesce(${mediaItems.moderatedAt}, '-infinity'::timestamptz)))::int as media_reported,
      e.id::text as edition_id,
      e.year as edition_year,
      e.title as edition_title,
      e.starts_at as edition_starts_at,
      ${rsvpCount("yes")} as rsvp_yes,
      ${rsvpCount("maybe")} as rsvp_maybe,
      ${rsvpCount("no")} as rsvp_no,
      coalesce((select sum(${cuencadaRsvps.guestCount}) from ${cuencadaRsvps}
         where ${cuencadaRsvps.cuencadaId} = e.id and ${cuencadaRsvps.status} = 'yes'), 0)::int as rsvp_guests
    from (select 1) as one
    left join edition e on true
  `);
  // Server-side data: safeParse and fail as a plain Error (→ logged 500), never a ZodError (→ 400).
  const parsed = summaryRowSchema.safeParse(result[0]);
  if (!parsed.success) throw new Error("loadAdminSummary: unexpected row shape");
  const row = parsed.data;
  const upcomingEdition =
    row.edition_id !== null && row.edition_year !== null && row.edition_title !== null && row.edition_starts_at !== null
      ? {
          cuencadaId: row.edition_id,
          year: row.edition_year,
          title: row.edition_title,
          startsAt: new Date(row.edition_starts_at).toISOString(),
          rsvpYes: row.rsvp_yes,
          rsvpMaybe: row.rsvp_maybe,
          rsvpNo: row.rsvp_no,
          rsvpGuests: row.rsvp_guests
        }
      : null;
  return {
    usersActive: row.users_active,
    usersDisabled: row.users_disabled,
    usersUnverified: row.users_unverified,
    activeAdmins: row.active_admins,
    invitesPending: row.invites_pending,
    mediaPendingReview: row.media_pending_review,
    mediaReported: row.media_reported,
    upcomingEdition
  };
}

/** Summary route, mounted under `/api`. */
const adminSummaryRoutes: FastifyPluginAsyncZod = async (app) => {
  /** `GET /api/admin/summary`: dashboard counters. */
  app.get(
    "/admin/summary",
    {
      config: { auth: "admin" },
      schema: {
        response: { 200: adminSummarySchema, 401: apiErrorSchema, 403: apiErrorSchema, 429: apiErrorSchema }
      }
    },
    async (): Promise<AdminSummary> => loadAdminSummary(app.db, app.clock.now())
  );
};

export default adminSummaryRoutes;
