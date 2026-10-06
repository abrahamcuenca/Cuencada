import type { PublicCuencada } from "@cuencada/types";

export const cuencada2026: PublicCuencada = {
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
  description: "Portal familiar para consultar programa, lugares, recuerdos y coordinación de la Cuencada en Mérida.",
  heroImageUrl: null,
  themeColor: "#0b5e55",
  publicItinerary: [
    { id: "13", date: "2026-09-13", time: "7:30 PM", title: "Llegada a Mérida", description: "Check-in en Hotel Chariot / Hotel El Conquistador. Encuentro familiar en lobby.", locationName: "Mérida", visibility: "public" },
    { id: "14", date: "2026-09-14", time: "8:00 AM", title: "Cenote Santa Bárbara e Izamal", description: "$1,000 p/p · cenote, comida yucateca e Izamal.", locationName: "Homún e Izamal", visibility: "public" },
    { id: "15", date: "2026-09-15", time: null, title: "Uxmal + Cuencada Fest", description: "Visita a Uxmal, cena, música, taquiza, DJ y mariachi.", locationName: "Uxmal / Mérida", visibility: "public" },
    { id: "16", date: "2026-09-16", time: null, title: "Chuburná, Isla Columpios y Progreso", description: "Playa, malecón, atardecer y regreso al hotel.", locationName: "Costa de Yucatán", visibility: "public" },
    { id: "17", date: "2026-09-17", time: null, title: "Día libre", description: "Compras, Centro Histórico y gastronomía yucateca.", locationName: "Mérida", visibility: "public" },
    { id: "18", date: "2026-09-18", time: null, title: "Despedida", description: "Tiempo libre y cierre de la reunión familiar.", locationName: "Mérida", visibility: "public" }
  ],
  publicLocations: [
    { id: "hotel-chariot", name: "Hotel Chariot Mérida", kind: "hotel", address: null, url: "https://www.hotelchariotmerida.com/" },
    { id: "hotel-conquistador", name: "Hotel El Conquistador", kind: "hotel", address: null, url: "https://www.elconquistador.com.mx/" },
    { id: "whatsapp", name: "Grupo WhatsApp Cuencada", kind: "other", address: null, url: "https://chat.whatsapp.com/IvI6oayIIoEJ8Wn7EWQxO0?s=cl&p=i&mlu=0" }
  ]
};
