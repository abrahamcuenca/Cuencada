/**
 * Contract-shaped RSVP fixtures and an in-memory fake of the T3 API for MSW
 * (tests and the screenshot stub). Test-only: never imported by app code.
 */
import type {
  AdminAttendanceBulkRequest,
  AdminRsvpRow,
  Attendee,
  AttendanceRecord,
  MemberCuencadaDetails,
  MyRsvp,
  MyRsvpResponse,
  PersonSummary,
  PublicCuencada,
  RsvpSummary
} from "@cuencada/types";
import { type HttpHandler, HttpResponse, http } from "msw";
import { apiUrl, errorBody, makeUser } from "../../../../test/auth";
import {
  fixtureId,
  makeAdminCuencada,
  makeAdminDetail,
  makeLocation,
  makeMemberDetails,
  makePublicCuencada
} from "../../cuencadas/testing/fixtures";

export const CUENCADA_2027_ID = fixtureId(2027);
export const HOTEL_A = fixtureId(271);
export const HOTEL_B = fixtureId(272);
export const VENUE = fixtureId(273);

/** The current test user (member), as in `test/auth.ts`. */
export const ME = makeUser({ personId: fixtureId(9001) });

/** A person id for fixture `n`. */
export function personId(n: number): string {
  return fixtureId(9000 + n);
}

/** A future edition (2027, Oaxaca-like data in the Mérida timezone). */
export function makeUpcomingCuencada(overrides: Partial<PublicCuencada> = {}): PublicCuencada {
  return makePublicCuencada({
    id: CUENCADA_2027_ID,
    year: 2027,
    slug: "2027",
    title: "Cuencada 2027",
    status: "upcoming",
    // Jul 10 00:00 → Jul 15 23:59:59 in Mérida (UTC-6, no DST).
    startsAt: "2027-07-10T06:00:00Z",
    endsAt: "2027-07-16T05:59:59Z",
    rsvpDeadline: "2027-06-01T05:59:00Z",
    publicItinerary: [],
    ...overrides
  });
}

/** Member details of 2027 with two hotels and a venue (not a hotel). */
export function makeUpcomingMembers(overrides: Partial<MemberCuencadaDetails> = {}): MemberCuencadaDetails {
  return makeMemberDetails({
    cuencadaId: CUENCADA_2027_ID,
    year: 2027,
    itinerary: [],
    announcements: [],
    locations: [
      makeLocation({ id: HOTEL_A, name: "Hotel Chariot Mérida", kind: "hotel" }),
      makeLocation({ id: VENUE, name: "Hacienda Xcanatún", kind: "venue", sortOrder: 1 }),
      makeLocation({ id: HOTEL_B, name: "Hotel Casa Lucía", kind: "hotel", sortOrder: 2 })
    ],
    ...overrides
  });
}

/** A saved RSVP. */
export function makeMyRsvp(overrides: Partial<MyRsvp> = {}): MyRsvp {
  return {
    cuencadaId: CUENCADA_2027_ID,
    status: "yes",
    guestCount: 2,
    arrivalDate: "2027-07-09",
    departureDate: "2027-07-15",
    hotelLocationId: HOTEL_A,
    notes: null,
    updatedAt: "2026-10-01T12:00:00Z",
    ...overrides
  };
}

/** An attendee row. */
export function makeAttendee(n: number, overrides: Partial<Attendee> = {}): Attendee {
  return {
    personId: personId(n),
    userId: null,
    displayName: `Familiar ${n}`,
    avatarUrl: null,
    source: "rsvp",
    rsvpStatus: "yes",
    ...overrides
  };
}

/** Realistic attendee names for screenshots and stack tests. */
export const FAMILY_NAMES = [
  "Rosa Cuenca",
  "Tomás Cuenca Ruiz",
  "María de la Luz Cuenca",
  "Javier Cuenca",
  "Lucía Herrera Cuenca",
  "Andrés Cuenca Pérez",
  "Fernanda Cuenca",
  "Diego Martín Cuenca",
  "Sofía Cuenca Ríos",
  "Emilio Cuenca",
  "Valeria Cuenca Ortiz",
  "Pablo Cuenca"
] as const;

/** A list of attendees with names from {@link FAMILY_NAMES}. */
export function makeAttendees(count: number): Attendee[] {
  return Array.from({ length: count }, (_, i) =>
    makeAttendee(i + 2, {
      displayName: FAMILY_NAMES[i % FAMILY_NAMES.length] ?? `Familiar ${i}`,
      rsvpStatus: i % 5 === 4 ? "maybe" : "yes"
    })
  );
}

/** A person for the attendance checklist. */
export function makePerson(n: number, fullName: string, overrides: Partial<PersonSummary> = {}): PersonSummary {
  return { id: personId(n), userId: null, fullName, nickname: null, deceased: false, avatarUrl: null, ...overrides };
}

/** An admin RSVP row. */
export function makeAdminRow(n: number, overrides: Partial<AdminRsvpRow> = {}): AdminRsvpRow {
  return {
    userId: fixtureId(8000 + n),
    personId: personId(n),
    displayName: `Familiar ${n}`,
    email: `familiar${n}@example.com`,
    status: "yes",
    guestCount: 1,
    arrivalDate: "2027-07-10",
    departureDate: "2027-07-15",
    hotelName: "Hotel Chariot Mérida",
    notes: null,
    updatedAt: "2026-10-01T12:00:00Z",
    ...overrides
  };
}

/** Mutable state behind {@link rsvpHandlers}. */
export interface FakeRsvpDb {
  cuencadas: Record<number, PublicCuencada>;
  members: Record<number, MemberCuencadaDetails>;
  my: MyRsvpResponse;
  /** `"forbidden"` answers 403 (email not verified). */
  attendees: Attendee[] | "forbidden";
  summary: RsvpSummary;
  attendance: AttendanceRecord[];
  people: PersonSummary[];
  adminRows: AdminRsvpRow[];
  csv: string;
  /** When set, `PUT rsvp/me` fails with this status (after `putDelayMs`). */
  failPutWith: 403 | 500 | null;
  putDelayMs: number;
  putBodies: unknown[];
  bulkBodies: AdminAttendanceBulkRequest[];
  /** `METHOD /path?query` of every handled request. */
  log: string[];
}

/** A fresh fake DB: 2026 past, 2027 upcoming with no answer yet. */
export function makeRsvpDb(): FakeRsvpDb {
  return {
    cuencadas: { 2026: makePublicCuencada(), 2027: makeUpcomingCuencada() },
    members: { 2026: makeMemberDetails(), 2027: makeUpcomingMembers() },
    my: { rsvp: null, deadline: "2099-06-01T05:59:00Z", editable: true },
    attendees: [],
    summary: { cuencadaId: CUENCADA_2027_ID, yes: 0, maybe: 0, no: 0, expectedPeople: 0, byHotel: [] },
    attendance: [],
    people: [],
    adminRows: [],
    csv: "displayName,email,status\r\nRosa Cuenca,rosa@example.com,yes\r\n",
    failPutWith: null,
    putDelayMs: 0,
    putBodies: [],
    bulkBodies: [],
    log: []
  };
}

function logRequest(db: FakeRsvpDb, request: Request): void {
  const url = new URL(request.url);
  db.log.push(`${request.method} ${url.pathname.replace(/^\/api/, "")}${url.search}`);
}

function yearOf(params: Record<string, unknown>): number {
  return Number(params.year);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * MSW handlers over a {@link FakeRsvpDb}: the public/member Cuencada reads
 * T3 depends on, every T3 endpoint, the admin Cuencada detail and
 * `GET /family/people`.
 */
export function rsvpHandlers(db: FakeRsvpDb): HttpHandler[] {
  return [
    http.get(apiUrl("/cuencadas/:year/members"), ({ request, params }) => {
      logRequest(db, request);
      const members = db.members[yearOf(params)];
      return members ? HttpResponse.json(members) : HttpResponse.json(errorBody("NOT_FOUND"), { status: 404 });
    }),
    http.get(apiUrl("/cuencadas/:year/rsvp/me"), ({ request }) => {
      logRequest(db, request);
      return HttpResponse.json(db.my);
    }),
    http.put(apiUrl("/cuencadas/:year/rsvp/me"), async ({ request }) => {
      logRequest(db, request);
      const body: unknown = await request.json();
      db.putBodies.push(body);
      if (db.putDelayMs > 0) await delay(db.putDelayMs);
      if (db.failPutWith === 403) {
        return HttpResponse.json(errorBody("FORBIDDEN", "Las confirmaciones ya cerraron."), { status: 403 });
      }
      if (db.failPutWith === 500) {
        return HttpResponse.json(errorBody("INTERNAL", "No pudimos guardar tu respuesta."), { status: 500 });
      }
      // Test-only fake: the body was validated by the client with the contract schema.
      const saved = { ...(body as Omit<MyRsvp, "cuencadaId" | "updatedAt">), cuencadaId: CUENCADA_2027_ID, updatedAt: "2026-10-06T12:00:00Z" };
      db.my = { ...db.my, rsvp: saved };
      return HttpResponse.json(saved);
    }),
    http.get(apiUrl("/cuencadas/:year/rsvp/summary"), ({ request }) => {
      logRequest(db, request);
      return HttpResponse.json(db.summary);
    }),
    http.get(apiUrl("/cuencadas/:year/attendees"), ({ request }) => {
      logRequest(db, request);
      if (db.attendees === "forbidden") {
        return HttpResponse.json(errorBody("FORBIDDEN", "Verifica tu correo."), { status: 403 });
      }
      return HttpResponse.json(db.attendees);
    }),
    http.get(apiUrl("/cuencadas/:year"), ({ request, params }) => {
      // `/cuencadas/home` falls through to the default handler.
      if (!/^\d{4}$/.test(String(params.year))) return undefined;
      logRequest(db, request);
      const cuencada = db.cuencadas[yearOf(params)];
      return cuencada ? HttpResponse.json(cuencada) : HttpResponse.json(errorBody("NOT_FOUND"), { status: 404 });
    }),

    http.get(apiUrl("/admin/cuencadas/:id/attendance"), ({ request }) => {
      logRequest(db, request);
      return HttpResponse.json(db.attendance);
    }),
    http.post(apiUrl("/admin/cuencadas/:id/attendance"), async ({ request }) => {
      logRequest(db, request);
      // Test-only fake: the client builds this body from `AdminAttendanceBulkRequest`.
      const body = (await request.json()) as { add: string[]; remove: string[] };
      db.bulkBodies.push(body);
      const kept = db.attendance.filter((record) => !body.remove.includes(record.personId));
      const added = body.add.map((id) => ({
        personId: id,
        displayName: db.people.find((person) => person.id === id)?.fullName ?? id,
        createdAt: "2026-10-06T12:00:00Z"
      }));
      db.attendance = [...kept, ...added];
      return HttpResponse.json(db.attendance);
    }),
    http.get(apiUrl("/admin/cuencadas/:id/rsvps.csv"), ({ request }) => {
      logRequest(db, request);
      return new HttpResponse(db.csv, { headers: { "content-type": "text/csv; charset=utf-8" } });
    }),
    http.get(apiUrl("/admin/cuencadas/:id/rsvps"), ({ request }) => {
      logRequest(db, request);
      return HttpResponse.json(db.adminRows);
    }),
    http.get(apiUrl("/admin/cuencadas/:id"), ({ request, params }) => {
      logRequest(db, request);
      if (params.id !== CUENCADA_2027_ID) return HttpResponse.json(errorBody("NOT_FOUND"), { status: 404 });
      const cuencada = db.cuencadas[2027] ?? makeUpcomingCuencada();
      const { publicItinerary: _i, publicLocations: _l, publicAnnouncements: _a, todayMessage: _t, ...base } = cuencada;
      return HttpResponse.json(makeAdminDetail({ cuencada: makeAdminCuencada({ ...base }) }));
    }),
    http.get(apiUrl("/family/people"), ({ request }) => {
      logRequest(db, request);
      const q = (new URL(request.url).searchParams.get("q") ?? "").toLocaleLowerCase("es-MX");
      const items = db.people.filter((person) => q === "" || person.fullName.toLocaleLowerCase("es-MX").includes(q));
      return HttpResponse.json({ items, nextCursor: null });
    })
  ];
}
