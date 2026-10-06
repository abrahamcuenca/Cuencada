import type { ItineraryItem, LocationItem, PublicCuencada } from "@cuencada/types";

// Temporary hardcoded data; moves into the idempotent seed in WP-0.3 and this file is deleted in T2.

function itinerary(
  id: string,
  date: string,
  startTime: string | null,
  title: string,
  description: string,
  locationName: string,
  sortOrder: number
): ItineraryItem {
  return { id, date, startTime, endTime: null, title, description, locationName, locationId: null, priceNote: null, visibility: "public", sortOrder };
}

function location(id: string, name: string, kind: LocationItem["kind"], url: string | null, mapsUrl: string | null, sortOrder: number): LocationItem {
  return { id, name, kind, description: null, address: null, url, mapsUrl, lat: null, lng: null, visibility: "public", sortOrder };
}

export const seededCuencada2026: PublicCuencada = {
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
  description: "Reunión familiar de la Familia Cuenca en Mérida, Yucatán. Programa, mapas, recuerdos y coordinación familiar en un solo portal.",
  heroImageUrl: "/images/Logo_Cuencada2026.jpg",
  themeColor: "#0b5e55",
  songUrl: null,
  weatherWidgetUrl: null,
  rsvpDeadline: null,
  publicItinerary: [
    itinerary("13", "2026-09-13", "19:30", "Llegada a Mérida", "Check-in en Hotel Chariot / Hotel El Conquistador y encuentro familiar en el lobby.", "Lobby Hotel Chariot", 0),
    itinerary("14", "2026-09-14", "08:00", "Cenote Santa Bárbara e Izamal", "Salida puntual hacia cenote, comida yucateca e Izamal.", "Homún e Izamal", 1),
    itinerary("15", "2026-09-15", null, "Uxmal + Cuencada Fest", "Visita a Uxmal y celebración mexicana por la noche.", "Uxmal / Mérida", 2),
    itinerary("16", "2026-09-16", null, "Chuburná, Isla Columpios y Progreso", "Día de playa, recorrido por Progreso y atardecer familiar.", "Costa de Yucatán", 3),
    itinerary("17", "2026-09-17", null, "Día libre", "Compras, Centro Histórico de Mérida, restaurantes y actividades extras.", "Mérida", 4),
    itinerary("18", "2026-09-18", null, "Despedida", "Tiempo libre para quienes permanezcan más tiempo en Mérida.", "Mérida", 5)
  ],
  publicLocations: [
    location("hotel-chariot", "Hotel Chariot Mérida", "hotel", "https://www.hotelchariotmerida.com/", null, 0),
    location("hotel-conquistador", "Hotel El Conquistador", "hotel", "https://www.elconquistador.com.mx/", null, 1),
    location("cenote-santa-barbara", "Cenotes Santa Bárbara", "venue", null, "https://www.google.com/maps/search/?api=1&query=Cenotes+Santa+Barbara+Homun+Yucatan", 2),
    location("izamal", "Izamal", "attraction", null, "https://www.google.com/maps/search/?api=1&query=Izamal+Yucatan", 3)
  ],
  publicAnnouncements: [],
  todayMessage: null
};
