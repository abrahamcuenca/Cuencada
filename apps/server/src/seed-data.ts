/**
 * Baseline content for the seed: the 2026 Cuencada, ported from the legacy
 * `index.html` page and `modules/cuencadas/data.ts`. Every value is checked
 * against the admin input contracts before it is written.
 */
import {
  type CreateCuencadaInput,
  type CreateItineraryItemInput,
  type CreateLocationInput,
  createCuencadaInputSchema,
  createItineraryItemInputSchema,
  createLocationInputSchema
} from "@cuencada/types";

/** Stable key used to link itinerary items to seeded locations. */
export type SeedLocationKey = "chariot" | "conquistador" | "cenote" | "izamal" | "uxmal" | "progreso";

/** A seeded location plus its link key. */
export interface SeedLocation {
  key: SeedLocationKey;
  input: CreateLocationInput;
}

/** A seeded itinerary item plus the location it points to, if any. */
export interface SeedItineraryItem {
  locationKey: SeedLocationKey | null;
  input: CreateItineraryItemInput;
}

/** The full 2026 edition. */
export interface SeedCuencada {
  cuencada: CreateCuencadaInput;
  locations: SeedLocation[];
  itinerary: SeedItineraryItem[];
  chatRoomTitle: string;
}

const MAPS = "https://www.google.com/maps/search/?api=1&query=";

function location(key: SeedLocationKey, input: Record<string, unknown>): SeedLocation {
  return { key, input: createLocationInputSchema.parse(input) };
}

function itinerary(locationKey: SeedLocationKey | null, input: Record<string, unknown>): SeedItineraryItem {
  return { locationKey, input: createItineraryItemInputSchema.parse(input) };
}

/** Build (and validate) the 2026 seed content. Throws if any value breaks a contract. */
export function cuencada2026(): SeedCuencada {
  const cuencada = createCuencadaInputSchema.parse({
    year: 2026,
    title: "Cuencada 2026",
    startsAt: "2026-09-13T00:00:00-06:00",
    endsAt: "2026-09-18T23:59:59-06:00",
    timezone: "America/Merida",
    city: "Mérida",
    state: "Yucatán",
    country: "México",
    description:
      "Una familia. Una historia. Una celebración. Bienvenidos al portal oficial de nuestra reunión familiar. " +
      "Aquí encontrarás el programa, actividades, ubicaciones y el álbum vivo de todos los momentos que compartamos en Mérida.",
    heroImageUrl: "/images/Logo_Cuencada2026.jpg",
    themeColor: "#0b5e55",
    songUrl: "/canciones/Cancion_Oficial.mp3",
    whatsappUrl: "https://chat.whatsapp.com/IvI6oayIIoEJ8Wn7EWQxO0?s=cl&p=i&mlu=0",
    weatherWidgetUrl: "https://forecast7.com/es/20d97n89d59/merida/",
    externalAlbumUrl: "https://1drv.ms/f/c/b0c7d5955d4a8581/IgAC5vDMrmIvTJwWwOjkJJM7AT3DxtBo9OFj8FSXJI_GQY0?e=ASBPLY",
    rsvpDeadline: null,
    isPublished: true
  });

  const locations = [
    location("chariot", {
      name: "Hotel Chariot Mérida",
      kind: "hotel",
      description: "Uno de los hoteles base de la Cuencada.",
      url: "https://www.hotelchariotmerida.com/"
    }),
    location("conquistador", {
      name: "Hotel El Conquistador",
      kind: "hotel",
      description: "Segundo hotel considerado para la familia.",
      url: "https://www.elconquistador.com.mx/"
    }),
    location("cenote", {
      name: "Cenote Santa Bárbara",
      kind: "attraction",
      description: "Actividad del lunes 14.",
      mapsUrl: `${MAPS}Cenotes+Santa+Barbara+Homun+Yucatan`
    }),
    location("izamal", {
      name: "Izamal",
      kind: "attraction",
      description: "Pueblo Mágico amarillo.",
      mapsUrl: `${MAPS}Izamal+Yucatan`
    }),
    location("uxmal", {
      name: "Uxmal",
      kind: "attraction",
      description: "Visita del martes 15.",
      mapsUrl: `${MAPS}Uxmal+Yucatan`
    }),
    location("progreso", {
      name: "Progreso",
      kind: "attraction",
      description: "Malecón y atardecer del miércoles 16.",
      mapsUrl: `${MAPS}Progreso+Yucatan`
    })
  ];

  const items = [
    itinerary("chariot", {
      date: "2026-09-13",
      startTime: "19:30",
      title: "Llegada a Mérida",
      description:
        "Check-in en Hotel Chariot / Hotel El Conquistador y encuentro familiar en el lobby. Nota: transporte de aeropuerto no incluido.",
      locationName: "Lobby Hotel Chariot"
    }),
    itinerary("cenote", {
      date: "2026-09-14",
      startTime: "07:40",
      endTime: "18:00",
      title: "Cenote Santa Bárbara e Izamal",
      description:
        "7:40 AM reunión · 8:00 AM salida puntual · 9:00 AM Cenote Santa Bárbara · 1:00 PM comida yucateca · 3:00 PM Izamal · 6:00 PM regreso al hotel. Transporte incluido.",
      locationName: "Homún e Izamal",
      priceNote: "$1,000 p/p"
    }),
    itinerary("uxmal", {
      date: "2026-09-15",
      title: "Uxmal + Cuencada Fest",
      description:
        "Visita matutina a Uxmal. Por la noche: cena, música, baile, taquiza, DJ, mariachi y celebración mexicana.",
      locationName: "Uxmal / Mérida"
    }),
    itinerary("progreso", {
      date: "2026-09-16",
      title: "Chuburná, Isla Columpios y Progreso",
      description:
        "Salida a Chuburná e Isla Columpios. Después, Progreso y recorrido por el malecón. 7:00 PM atardecer · 8:00 PM regreso al hotel.",
      locationName: "Costa de Yucatán"
    }),
    itinerary(null, {
      date: "2026-09-17",
      title: "Día libre",
      description: "Compras, Centro Histórico de Mérida, restaurantes y actividades extras.",
      locationName: "Mérida"
    }),
    itinerary(null, {
      date: "2026-09-18",
      title: "Despedida",
      description: "Tiempo libre para quienes permanezcan más tiempo en Mérida.",
      locationName: "Mérida"
    })
  ];

  return { cuencada, locations, itinerary: items, chatRoomTitle: "Familia Cuenca" };
}
