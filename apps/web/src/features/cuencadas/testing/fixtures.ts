/**
 * Contract-shaped fixtures for the Cuencadas tests and the screenshot stub
 * API. Content mirrors the 2026 seed (WP-0.3). Test-only: never imported by
 * application code.
 */
import type {
  AdminCuencada,
  AdminCuencadaDetail,
  Announcement,
  CuencadaHome,
  CuencadaSummary,
  DailyMessage,
  ItineraryItem,
  LocationItem,
  MemberCuencadaDetails,
  PublicCuencada
} from "@cuencada/types";

/** A deterministic uuid (v4 shape) for fixture `n`. */
export function fixtureId(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

export const CUENCADA_2026_ID = fixtureId(2026);

/** Legacy production-style links, returned unchanged by the API. */
export const LINKS = {
  whatsapp: "https://chat.whatsapp.com/EjemploDeGrupo?s=cl&p=i&mlu=0",
  album: "https://1drv.ms/f/c/ejemplo/album?e=ABC123",
  weather: "https://forecast7.com/es/20d97n89d59/merida/",
  hotel: "https://www.hotelchariotmerida.com/",
  maps: "https://www.google.com/maps/search/?api=1&query=Cenotes+Santa+Barbara+Homun+Yucatan"
} as const;

/** An itinerary item. */
export function makeItinerary(overrides: Partial<ItineraryItem> = {}): ItineraryItem {
  return {
    id: fixtureId(100),
    date: "2026-09-14",
    startTime: "07:40",
    endTime: "18:00",
    title: "💦 Cenote & Izamal",
    description: "Reunión, salida puntual, Cenote Santa Bárbara, comida yucateca e Izamal.",
    locationName: "Cenote Santa Bárbara",
    locationId: fixtureId(203),
    priceNote: "$1,000 p/p",
    visibility: "public",
    sortOrder: 0,
    ...overrides
  };
}

/** A location. */
export function makeLocation(overrides: Partial<LocationItem> = {}): LocationItem {
  return {
    id: fixtureId(201),
    name: "Hotel Chariot Mérida",
    kind: "hotel",
    description: "Uno de los hoteles base de la Cuencada.",
    address: null,
    url: LINKS.hotel,
    mapsUrl: null,
    lat: null,
    lng: null,
    visibility: "public",
    sortOrder: 0,
    ...overrides
  };
}

/** An announcement. */
export function makeAnnouncement(overrides: Partial<Announcement> = {}): Announcement {
  return {
    id: fixtureId(300),
    cuencadaId: CUENCADA_2026_ID,
    title: "Ver programa completo",
    body: "Consulta el programa oficial: https://1drv.ms/i/c/ejemplo/programa",
    visibility: "public",
    pinned: false,
    authorName: "Administración",
    // 03:30 UTC on Sep 1 is still Aug 31 in Mérida.
    publishedAt: "2026-09-01T03:30:00Z",
    updatedAt: "2026-09-01T03:30:00Z",
    ...overrides
  };
}

/** A daily message. */
export function makeDailyMessage(overrides: Partial<DailyMessage> = {}): DailyMessage {
  return { id: fixtureId(400), date: "2026-09-13", message: "¡Bienvenidos a Mérida, familia!", ...overrides };
}

/** The 2026 edition as the public API returns it. */
export function makePublicCuencada(overrides: Partial<PublicCuencada> = {}): PublicCuencada {
  return {
    id: CUENCADA_2026_ID,
    year: 2026,
    slug: "2026",
    title: "Cuencada 2026",
    status: "past",
    // 00:00 on Sep 13 in Mérida (UTC-6) → 23:59:59 on Sep 18 in Mérida (19th in UTC).
    startsAt: "2026-09-13T06:00:00Z",
    endsAt: "2026-09-19T05:59:59Z",
    timezone: "America/Merida",
    city: "Mérida",
    state: "Yucatán",
    country: "México",
    description: "Del domingo 13 al viernes 18 de septiembre.",
    heroImageUrl: null,
    themeColor: "#0b5e55",
    songUrl: "/canciones/Cancion_Oficial.mp3",
    weatherWidgetUrl: LINKS.weather,
    rsvpDeadline: null,
    publicItinerary: [
      makeItinerary({ id: fixtureId(101), date: "2026-09-13", startTime: "19:30", endTime: null, title: "🌴 Llegada a Mérida", priceNote: null, locationName: "Lobby Chariot", sortOrder: 0 }),
      makeItinerary({ id: fixtureId(102), sortOrder: 1 }),
      makeItinerary({ id: fixtureId(103), date: "2026-09-15", startTime: null, endTime: null, title: "🇲🇽 Uxmal + CUENCADA FEST", priceNote: null, locationName: "Uxmal", sortOrder: 2 })
    ],
    publicLocations: [
      makeLocation(),
      makeLocation({ id: fixtureId(203), name: "Cenote Santa Bárbara", kind: "attraction", description: "Actividad del lunes 14.", url: null, mapsUrl: LINKS.maps, sortOrder: 1 })
    ],
    publicAnnouncements: [],
    todayMessage: null,
    ...overrides
  };
}

/** Member-only details of 2026 (lists include public + members-only items). */
export function makeMemberDetails(overrides: Partial<MemberCuencadaDetails> = {}): MemberCuencadaDetails {
  const base = makePublicCuencada();
  return {
    cuencadaId: CUENCADA_2026_ID,
    year: 2026,
    itinerary: [
      ...base.publicItinerary,
      makeItinerary({ id: fixtureId(104), date: "2026-09-15", startTime: "20:00", endTime: null, title: "Cena familiar privada", visibility: "members", priceNote: null, locationName: null, sortOrder: 3 })
    ],
    locations: base.publicLocations,
    announcements: [makeAnnouncement({ id: fixtureId(301), title: "Ver letra oficial", body: "La letra: https://1drv.ms/w/c/ejemplo/letra", visibility: "members", pinned: true })],
    whatsappUrl: LINKS.whatsapp,
    externalAlbumUrl: LINKS.album,
    ...overrides
  };
}

/** A summary for lists. */
export function makeSummary(overrides: Partial<CuencadaSummary> = {}): CuencadaSummary {
  return {
    id: CUENCADA_2026_ID,
    year: 2026,
    slug: "2026",
    title: "Cuencada 2026",
    status: "past",
    startsAt: "2026-09-13T06:00:00Z",
    endsAt: "2026-09-19T05:59:59Z",
    city: "Mérida",
    state: "Yucatán",
    heroImageUrl: null,
    themeColor: "#0b5e55",
    ...overrides
  };
}

/** `GET /cuencadas/home` in memories mode (today: 2026 is over). */
export function makeMemoriesHome(overrides: Partial<CuencadaHome> = {}): CuencadaHome {
  return {
    mode: "memories",
    featured: null,
    latestPast: makeSummary(),
    announcements: [makeAnnouncement({ id: fixtureId(302), cuencadaId: null, title: "¡Gracias por venir!", body: "Pronto subiremos más fotos." })],
    ...overrides
  };
}

/** The 2026 edition as admins see it. */
export function makeAdminCuencada(overrides: Partial<AdminCuencada> = {}): AdminCuencada {
  const { publicItinerary: _i, publicLocations: _l, publicAnnouncements: _a, todayMessage: _t, ...base } = makePublicCuencada();
  return {
    ...base,
    isPublished: true,
    whatsappUrl: LINKS.whatsapp,
    externalAlbumUrl: LINKS.album,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides
  };
}

/** `GET /admin/cuencadas/:id`. */
export function makeAdminDetail(overrides: Partial<AdminCuencadaDetail> = {}): AdminCuencadaDetail {
  const members = makeMemberDetails();
  return {
    cuencada: makeAdminCuencada(),
    itinerary: members.itinerary,
    locations: members.locations,
    announcements: members.announcements,
    dailyMessageCount: 0,
    ...overrides
  };
}
