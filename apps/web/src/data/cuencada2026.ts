import type { ItineraryItem, LocationItem, PublicCuencada } from "@cuencada/types";

// Temporary static data until the web calls the API (deleted in T2).

function itinerary(
  id: string,
  date: string,
  startTime: string | null,
  title: string,
  description: string,
  locationName: string,
  sortOrder: number,
  priceNote: string | null = null
): ItineraryItem {
  return { id, date, startTime, endTime: null, title, description, locationName, locationId: null, priceNote, visibility: "public", sortOrder };
}

function location(id: string, name: string, kind: LocationItem["kind"], url: string, sortOrder: number): LocationItem {
  return { id, name, kind, description: null, address: null, url, mapsUrl: null, lat: null, lng: null, visibility: "public", sortOrder };
}

export const cuencada2026: PublicCuencada = {
  id: "seed-2026",
  year: 2026,
  slug: "2026",
  title: "Cuencada 2026",
  status: "upcoming",
  startsAt: "2026-09-13T00:00:00-06:00",
  endsAt: "2026-09-18T23:59:59-06:00",
  timezone: "America/Merida",
  city: "Mérida",
  state: "Yucatán",
  country: "México",
  description: "Portal familiar para consultar programa, lugares, recuerdos y coordinación de la Cuencada en Mérida.",
  heroImageUrl: null,
  themeColor: "#0b5e55",
  songUrl: null,
  weatherWidgetUrl: null,
  rsvpDeadline: null,
  publicItinerary: [
    itinerary("13", "2026-09-13", "19:30", "Llegada a Mérida", "Check-in en Hotel Chariot / Hotel El Conquistador. Encuentro familiar en lobby.", "Mérida", 0),
    itinerary("14", "2026-09-14", "08:00", "Cenote Santa Bárbara e Izamal", "Cenote, comida yucateca e Izamal.", "Homún e Izamal", 1, "$1,000 p/p"),
    itinerary("15", "2026-09-15", null, "Uxmal + Cuencada Fest", "Visita a Uxmal, cena, música, taquiza, DJ y mariachi.", "Uxmal / Mérida", 2),
    itinerary("16", "2026-09-16", null, "Chuburná, Isla Columpios y Progreso", "Playa, malecón, atardecer y regreso al hotel.", "Costa de Yucatán", 3),
    itinerary("17", "2026-09-17", null, "Día libre", "Compras, Centro Histórico y gastronomía yucateca.", "Mérida", 4),
    itinerary("18", "2026-09-18", null, "Despedida", "Tiempo libre y cierre de la reunión familiar.", "Mérida", 5)
  ],
  publicLocations: [
    location("hotel-chariot", "Hotel Chariot Mérida", "hotel", "https://www.hotelchariotmerida.com/", 0),
    location("hotel-conquistador", "Hotel El Conquistador", "hotel", "https://www.elconquistador.com.mx/", 1),
    location("whatsapp", "Grupo WhatsApp Cuencada", "other", "https://chat.whatsapp.com/IvI6oayIIoEJ8Wn7EWQxO0?s=cl&p=i&mlu=0", 2)
  ],
  publicAnnouncements: [],
  todayMessage: null
};
