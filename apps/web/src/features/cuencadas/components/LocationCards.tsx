import type { LocationItem, LocationKind } from "@cuencada/types";
import type { ReactNode } from "react";
import { Badge } from "../../../shared/ui/Badge";
import { Button } from "../../../shared/ui/Button";
import { Card } from "../../../shared/ui/Card";
import { EmptyState } from "../../../shared/ui/EmptyState";
import { safeHttpsUrl } from "../lib/format";
import styles from "./content.module.css";

const KIND_ICON: Record<LocationKind, string> = {
  hotel: "🏨",
  venue: "🎉",
  attraction: "🌴",
  other: "📍"
};

const KIND_FALLBACK_TEXT: Record<LocationKind, string> = {
  hotel: "Hotel base de la Cuencada.",
  venue: "Sede de las actividades.",
  attraction: "Lugar del recorrido.",
  other: "Lugar importante de la Cuencada."
};

/**
 * "¿Dónde estamos?" cards: hotels, venues and attractions with their Google
 * Maps and website links. Links are rendered exactly as the API returns them
 * (production OneDrive/hotel/Maps links), and only when they are https.
 */
export function LocationCards({ locations }: { locations: readonly LocationItem[] }): ReactNode {
  if (locations.length === 0) {
    return <EmptyState icon="🗺️" headingLevel={3} title="Pronto publicaremos los lugares" description="Hoteles y sedes aparecerán aquí." />;
  }
  const sorted = [...locations].sort((a, b) => a.sortOrder - b.sortOrder);
  return (
    <ul className={styles.locations}>
      {sorted.map((location) => (
        <LocationCard key={location.id} location={location} />
      ))}
    </ul>
  );
}

function LocationCard({ location }: { location: LocationItem }): ReactNode {
  const mapsUrl = safeHttpsUrl(location.mapsUrl);
  const siteUrl = safeHttpsUrl(location.url);
  return (
    <Card as="li" className={styles.location}>
      <h3 className={styles.locationName}>
        <span aria-hidden="true">{KIND_ICON[location.kind]} </span>
        {location.name}
      </h3>
      {location.visibility === "members" ? <Badge tone="accent">🔒 Solo familia</Badge> : null}
      <p>{location.description ?? KIND_FALLBACK_TEXT[location.kind]}</p>
      {location.address ? <p className={styles.meta}>{location.address}</p> : null}
      {mapsUrl || siteUrl ? (
        <div className={styles.linkRow}>
          {mapsUrl ? (
            <Button href={mapsUrl} external variant="secondary" size="sm" icon="🗺️" iconEnd="↗">
              Abrir en Google Maps
            </Button>
          ) : null}
          {siteUrl ? (
            <Button href={siteUrl} external variant="secondary" size="sm" iconEnd="↗">
              {location.kind === "hotel" ? "Abrir sitio del hotel" : "Abrir sitio"}
            </Button>
          ) : null}
        </div>
      ) : null}
    </Card>
  );
}
