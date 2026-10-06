/**
 * Admin dashboard summary: every counter is computed in one SQL statement.
 */
import { type AdminSummary, adminSummarySchema, apiErrorSchema } from "@cuencada/types";
import { sql } from "drizzle-orm";
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
  const result = await db.execute(sql`
    with edition as (
      select id, year, title, starts_at from cuencadas
      where is_published and ends_at > ${at}::timestamptz
      order by starts_at asc, id asc
      limit 1
    )
    select
      (select count(*) from users where status = 'active')::int as users_active,
      (select count(*) from users where status = 'disabled')::int as users_disabled,
      (select count(*) from users where status = 'active' and email_verified_at is null)::int as users_unverified,
      (select count(*) from users where status = 'active' and role = 'admin')::int as active_admins,
      (select count(*) from invites where status = 'pending' and expires_at > ${at}::timestamptz)::int as invites_pending,
      (select count(*) from media_items
         where deleted_at is null and upload_status <> 'pending_upload'
           and moderation_status = 'pending_review')::int as media_pending_review,
      (select count(*) from media_items m
         where m.deleted_at is null and m.upload_status <> 'pending_upload'
           and exists (select 1 from media_reports r
                       where r.media_id = m.id
                         and r.created_at > coalesce(m.moderated_at, '-infinity'::timestamptz)))::int as media_reported,
      e.id::text as edition_id,
      e.year as edition_year,
      e.title as edition_title,
      e.starts_at as edition_starts_at,
      coalesce((select count(*) from cuencada_rsvps r where r.cuencada_id = e.id and r.status = 'yes'), 0)::int as rsvp_yes,
      coalesce((select count(*) from cuencada_rsvps r where r.cuencada_id = e.id and r.status = 'maybe'), 0)::int as rsvp_maybe,
      coalesce((select count(*) from cuencada_rsvps r where r.cuencada_id = e.id and r.status = 'no'), 0)::int as rsvp_no,
      coalesce((select sum(guest_count) from cuencada_rsvps r where r.cuencada_id = e.id and r.status = 'yes'), 0)::int as rsvp_guests
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
