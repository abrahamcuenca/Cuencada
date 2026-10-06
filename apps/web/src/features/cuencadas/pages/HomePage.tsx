import type { Announcement, CuencadaHome, CuencadaSummary, PublicCuencada } from "@cuencada/types";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { useAppSelector } from "../../../app/hooks";
import { Button } from "../../../shared/ui/Button";
import { Card } from "../../../shared/ui/Card";
import { Countdown } from "../../../shared/ui/Countdown";
import { selectAuthStatus, selectCurrentUser, selectPasswordChangeRequired } from "../../auth/authSlice";
import { useGetCuencadaHomeQuery, useListCuencadasQuery, useListMemberAnnouncementsQuery } from "../api";
import { AnnouncementList } from "../components/AnnouncementList";
import { CuencadaHero } from "../components/CuencadaHero";
import { DailyMessageCard } from "../components/DailyMessageCard";
import { LoadErrorState, OfflineNotice, SectionSkeleton } from "../components/PageStates";
import { Section } from "../components/Section";
import { RsvpSlot } from "../components/slots";
import { useNow } from "../hooks/useNow";
import { useOnNewDay } from "../hooks/useZonedToday";
import { countdownInstants, formatKicker, safeAssetUrl } from "../lib/format";
import styles from "./home.module.css";

const TAGLINE = "Una familia. Una historia. Una celebración.";
/** Timezone for portal-wide content that belongs to no edition (the family's home base). */
const PORTAL_TIMEZONE = "America/Merida";

/**
 * Home `/`. The server computes the mode from the editions' dates in their
 * timezone (`CuencadaHome.mode`):
 * - `upcoming` / `active`: the next edition's hero with a live countdown
 *   (it becomes "¡YA LLEGÓ LA CUENCADA!" while active), "Ver programa" and the
 *   RSVP slot, plus today's message in the edition's timezone.
 * - `memories`: thanks for the last edition, a link to its gallery and the
 *   list of past editions. With no edition at all, a "próximamente" hero.
 *
 * Portal-wide announcements: the public ones come with the home response;
 * members also get the members-only ones.
 */
export function HomePage(): ReactNode {
  const home = useGetCuencadaHomeQuery();

  if (home.data === undefined) {
    // The hero shell paints at once (fast LCP); only the edition-specific parts wait.
    return (
      <>
        <CuencadaHero kicker="Portal de la Familia Cuenca" titleStyle="display" title="CUENCADA" lead={TAGLINE} />
        {home.error === undefined ? (
          <SectionSkeleton />
        ) : (
          <LoadErrorState error={home.error} onRetry={() => void home.refetch()} />
        )}
      </>
    );
  }

  return (
    <>
      {home.data.featured ? <UpcomingHero featured={home.data.featured} /> : <MemoriesHero latestPast={home.data.latestPast} />}
      <div className="cu-container">{home.error !== undefined ? <OfflineNotice onRetry={() => void home.refetch()} /> : null}</div>
      {home.data.featured ? <TodayMessage featured={home.data.featured} onNewDay={() => void home.refetch()} /> : null}
      <HomeAnnouncements home={home.data} />
      {home.data.featured ? null : <Memories latestPast={home.data.latestPast} />}
      <Highlights featuredYear={home.data.featured?.year ?? home.data.latestPast?.year ?? null} />
      <PastEditions />
    </>
  );
}

function UpcomingHero({ featured }: { featured: PublicCuencada }): ReactNode {
  const now = useNow(featured.endsAt);
  return (
    <CuencadaHero
      kicker={formatKicker(featured)}
      titleStyle="display"
      title="CUENCADA"
      lead={TAGLINE}
      imageUrl={safeAssetUrl(featured.heroImageUrl)}
      actions={
        <Button to={`/cuencada/${featured.year}#programa`} surface="dark" size="lg" icon="📅">
          Ver programa
        </Button>
      }
    >
      <Countdown {...countdownInstants(featured.status, featured.startsAt, featured.endsAt, now)} />
      <RsvpSlot year={featured.year} />
    </CuencadaHero>
  );
}

function MemoriesHero({ latestPast }: { latestPast: CuencadaSummary | null }): ReactNode {
  return (
    <CuencadaHero
      kicker={latestPast ? "Gracias por una Cuencada inolvidable" : "Portal de la Familia Cuenca"}
      titleStyle="display"
      title="CUENCADA"
      lead={TAGLINE}
      imageUrl={safeAssetUrl(latestPast?.heroImageUrl ?? null)}
      actions={
        latestPast ? (
          <>
            <Button to={`/galeria/${latestPast.year}`} surface="dark" icon="📸">
              Ver recuerdos de {latestPast.year}
            </Button>
            <Button to={`/cuencada/${latestPast.year}`} variant="secondary" surface="dark" icon="📅">
              Ver programa {latestPast.year}
            </Button>
          </>
        ) : null
      }
    >
      <p className={styles.thanks}>
        <span aria-hidden="true">💛 </span>
        {latestPast
          ? `Gracias por acompañarnos. La ${latestPast.title} en ${latestPast.city} ya es parte de nuestra historia.`
          : "Muy pronto anunciaremos la próxima Cuencada."}
      </p>
    </CuencadaHero>
  );
}

/**
 * Today's message in the edition's timezone. A timer to the next local
 * midnight refetches Home, so the new day's message replaces yesterday's
 * without a reload (the old one hides at once: its date no longer matches).
 */
function TodayMessage({ featured, onNewDay }: { featured: PublicCuencada; onNewDay: () => void }): ReactNode {
  const today = useOnNewDay(featured.timezone, onNewDay);
  const message = featured.todayMessage?.date === today ? featured.todayMessage : null;
  if (message === null) return null;
  return (
    <div className="cu-container">
      <DailyMessageCard message={message} timeZone={featured.timezone} />
    </div>
  );
}

/** Public portal-wide announcements, plus members-only ones for logged-in members. */
function HomeAnnouncements({ home }: { home: CuencadaHome }): ReactNode {
  const status = useAppSelector(selectAuthStatus);
  const user = useAppSelector(selectCurrentUser);
  const mustChange = useAppSelector(selectPasswordChangeRequired);
  const isMember = status === "authenticated" && user !== null && !mustChange;
  const members = useListMemberAnnouncementsQuery(undefined, { skip: !isMember });

  const byId = new Map<string, Announcement>();
  for (const announcement of [...home.announcements, ...(isMember ? (members.data ?? []) : [])]) {
    byId.set(announcement.id, announcement);
  }
  if (byId.size === 0) return null;
  return (
    <Section id="avisos" icon="📣" title="Avisos">
      <AnnouncementList announcements={[...byId.values()]} timeZone={home.featured?.timezone ?? PORTAL_TIMEZONE} />
    </Section>
  );
}

const MEMORY_PHOTOS = ["foto01", "foto02", "foto03", "foto04"] as const;

function Memories({ latestPast }: { latestPast: CuencadaSummary | null }): ReactNode {
  return (
    <>
      <Section id="recuerdos" icon="📸" title="Últimos momentos" intro="Una pequeña muestra de las fotografías de la Cuencada.">
        <ul className={styles.mosaic}>
          {MEMORY_PHOTOS.map((photo) => (
            <li key={photo}>
              <img src={`/images/fotos/${photo}.jpg`} alt="Familia Cuenca en la Cuencada" width={960} height={720} loading="lazy" decoding="async" />
            </li>
          ))}
        </ul>
        {latestPast ? (
          <Button to={`/galeria/${latestPast.year}`} variant="secondary" className={styles.mosaicAction}>
            Ver álbum completo
          </Button>
        ) : null}
      </Section>
      <div className="cu-container">
        <Card tone="accent" icon="🗓️" title="La próxima Cuencada" className={styles.next}>
          <p>Todavía no tiene fecha. Te avisaremos cuando se publique.</p>
        </Card>
      </div>
    </>
  );
}

const HIGHLIGHTS = [
  { icon: "📅", title: "Programa", text: "Consulta cada día, horarios y actividades.", path: (year: number | null) => (year ? `/cuencada/${year}` : null) },
  { icon: "📸", title: "Álbum vivo", text: "Fotos y videos por año, privados para la familia.", path: (year: number | null) => (year ? `/galeria/${year}` : "/galeria") },
  { icon: "🧭", title: "Directorio", text: "Perfiles familiares con privacidad para correo y teléfono.", path: () => "/directorio" },
  { icon: "🌳", title: "Árbol familiar", text: "Generaciones, parentescos e historia de la Familia Cuenca.", path: () => "/arbol" }
] as const;

function Highlights({ featuredYear }: { featuredYear: number | null }): ReactNode {
  return (
    <Section id="todo" title="Todo en un solo lugar">
      <ul className={styles.highlights}>
        {HIGHLIGHTS.map((item) => {
          const to = item.path(featuredYear);
          if (to === null) return null;
          return (
            <li key={item.title}>
              <Link to={to} className={styles.highlight}>
                <span aria-hidden="true" className={styles.highlightIcon}>
                  {item.icon}
                </span>
                <span className={styles.highlightText}>
                  <strong>{item.title}</strong>
                  <span>{item.text}</span>
                </span>
                <span aria-hidden="true" className={styles.chevron}>
                  ›
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </Section>
  );
}

/** "Cuencadas anteriores": past published editions as chips. */
function PastEditions(): ReactNode {
  const list = useListCuencadasQuery();
  const past = (list.data ?? []).filter((cuencada) => cuencada.status === "past");
  if (past.length === 0) return null;
  return (
    <Section id="anteriores" icon="📜" title="Cuencadas anteriores">
      <ul className={styles.editions}>
        {past.map((cuencada) => (
          <li key={cuencada.id}>
            <Link to={`/cuencada/${cuencada.year}`} className={styles.edition}>
              <strong>{cuencada.year}</strong> · {cuencada.city}
            </Link>
          </li>
        ))}
      </ul>
    </Section>
  );
}
