import type { PublicCuencada } from "@cuencada/types";

export const seededCuencada2026: PublicCuencada = {
  id: "seed-2026",
  year: 2026,
  slug: "2026",
  title: "Cuencada 2026",
  status: "upcoming",
  startsAt: "2026-09-13T00:00:00-06:00",
  endsAt: "2026-09-18T23:59:59-06:00",
  city: "Mérida",
  state: "Yucatán",
  country: "México",
  description: "Reunión familiar de la Familia Cuenca en Mérida, Yucatán. Programa, mapas, recuerdos y coordinación familiar en un solo portal.",
  heroImageUrl: "/images/Logo_Cuencada2026.jpg",
  themeColor: "#0b5e55",
  publicItinerary: [
    { id: "13", date: "2026-09-13", time: "19:30", title: "Llegada a Mérida", description: "Check-in en Hotel Chariot / Hotel El Conquistador y encuentro familiar en el lobby.", locationName: "Lobby Hotel Chariot", visibility: "public" },
    { id: "14", date: "2026-09-14", time: "08:00", title: "Cenote Santa Bárbara e Izamal", description: "Salida puntual hacia cenote, comida yucateca e Izamal.", locationName: "Homún e Izamal", visibility: "public" },
    { id: "15", date: "2026-09-15", time: null, title: "Uxmal + Cuencada Fest", description: "Visita a Uxmal y celebración mexicana por la noche.", locationName: "Uxmal / Mérida", visibility: "public" },
    { id: "16", date: "2026-09-16", time: null, title: "Chuburná, Isla Columpios y Progreso", description: "Día de playa, recorrido por Progreso y atardecer familiar.", locationName: "Costa de Yucatán", visibility: "public" },
    { id: "17", date: "2026-09-17", time: null, title: "Día libre", description: "Compras, Centro Histórico de Mérida, restaurantes y actividades extras.", locationName: "Mérida", visibility: "public" },
    { id: "18", date: "2026-09-18", time: null, title: "Despedida", description: "Tiempo libre para quienes permanezcan más tiempo en Mérida.", locationName: "Mérida", visibility: "public" }
  ],
  publicLocations: [
    { id: "hotel-chariot", name: "Hotel Chariot Mérida", kind: "hotel", address: null, url: "https://www.hotelchariotmerida.com/" },
    { id: "hotel-conquistador", name: "Hotel El Conquistador", kind: "hotel", address: null, url: "https://www.elconquistador.com.mx/" },
    { id: "cenote-santa-barbara", name: "Cenotes Santa Bárbara", kind: "venue", address: null, url: "https://www.google.com/maps/search/?api=1&query=Cenotes+Santa+Barbara+Homun+Yucatan" },
    { id: "izamal", name: "Izamal", kind: "map", address: null, url: "https://www.google.com/maps/search/?api=1&query=Izamal+Yucatan" }
  ]
};
