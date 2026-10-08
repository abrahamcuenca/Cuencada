import {
  type Announcement,
  type CuencadaHome,
  type CuencadaSummary,
  type DatedCuencada,
  hasDates,
  type PublicCuencada,
} from "@cuencada/types";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { useAppSelector } from "../../../app/hooks";
import { Button } from "../../../shared/ui/Button";
import { Card } from "../../../shared/ui/Card";
import { Countdown } from "../../../shared/ui/Countdown";
import {
  selectAuthStatus,
  selectCurrentUser,
  selectPasswordChangeRequired,
  selectSessionAudience,
} from "../../auth/authSlice";
import { GalleryPreview } from "../../gallery/components/GalleryPreview";
import { CompleteProfileCard } from "../../profile/components/CompleteProfileCard";
import {
  useGetCuencadaHomeQuery,
  useListCuencadasQuery,
  useListMemberAnnouncementsQuery,
} from "../api";
import { AnnouncementList } from "../components/AnnouncementList";
import { CuencadaHero } from "../components/CuencadaHero";
import { DailyMessageCard } from "../components/DailyMessageCard";
import {
  LoadErrorState,
  OfflineNotice,
  SectionSkeleton,
} from "../components/PageStates";
import { Section } from "../components/Section";
import { RsvpSlot } from "../components/slots";
import { useNow } from "../hooks/useNow";
import { useOnNewDay } from "../hooks/useZonedToday";
import {
  countdownInstants,
  DATE_AND_PLACE_TO_BE_ANNOUNCED,
  formatKicker,
  formatPlace,
  safeAssetUrl,
} from "../lib/format";
import { programaYear } from "../lib/programa";
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
 * - `announced`: the next edition has no dates yet. "Cuencada {year}" with
 *   "Fecha y lugar por anunciar", **no countdown**, the RSVP slot (which only
 *   says RSVPs open once the date is announced) and the last edition's memories.
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
        <CuencadaHero
          kicker="Portal de la Familia Cuenca"
          titleStyle="display"
          title="CUENCADA"
          lead={TAGLINE}
        />
        {home.error === undefined ? (
          <SectionSkeleton />
        ) : (
          <LoadErrorState
            error={home.error}
            onRetry={() => void home.refetch()}
          />
        )}
      </>
    );
  }

  const { featured, latestPast } = home.data;
  return (
    <>
      <FeaturedHero featured={featured} latestPast={latestPast} />
      <div className="cu-container">
        {home.error !== undefined ? (
          <OfflineNotice onRetry={() => void home.refetch()} />
        ) : null}
        <CompleteProfileCard />
      </div>
      {featured ? (
        <TodayMessage
          featured={featured}
          onNewDay={() => void home.refetch()}
        />
      ) : null}
      <HomeAnnouncements home={home.data} />
      {featured === null ? <Memories latestPast={latestPast} /> : null}
      {featured !== null && !hasDates(featured) && latestPast ? (
        <MemoriesPhotosSection latestPast={latestPast} />
      ) : null}
      <Highlights featuredYear={programaYear(home.data)} />
      <PastEditions />
    </>
  );
}

/**
 * Picks the hero: a dated edition gets the countdown, an announced one (no
 * dates yet) a "Fecha y lugar por anunciar" hero without countdown, and no
 * featured edition the memories hero. `hasDates` narrows the type, so the
 * countdown can never receive a `null` date.
 */
function FeaturedHero({
  featured,
  latestPast,
}: {
  featured: PublicCuencada | null;
  latestPast: CuencadaSummary | null;
}): ReactNode {
  if (featured === null) return <MemoriesHero latestPast={latestPast} />;
  if (hasDates(featured)) return <UpcomingHero featured={featured} />;
  return <AnnouncedHero featured={featured} latestPast={latestPast} />;
}

function UpcomingHero({
  featured,
}: { featured: DatedCuencada<PublicCuencada> }): ReactNode {
  const now = useNow(featured.endsAt);
  return (
    <CuencadaHero
      kicker={formatKicker(featured)}
      titleStyle="display"
      title="CUENCADA"
      lead={TAGLINE}
      imageUrl={safeAssetUrl(featured.heroImageUrl)}
      actions={
        <Button
          to={`/cuencada/${featured.year}#programa`}
          surface="dark"
          size="lg"
          icon="📅"
        >
          Ver programa
        </Button>
      }
    >
      <Countdown
        {...countdownInstants(
          featured.status,
          featured.startsAt,
          featured.endsAt,
          now,
        )}
      />
      <RsvpSlot year={featured.year} />
    </CuencadaHero>
  );
}

/**
 * The next edition is announced but has no dates yet: its year, what is
 * still open ("Fecha y lugar por anunciar", or only the date when the place
 * is known), no countdown, and the previous edition's memories.
 */
function AnnouncedHero({
  featured,
  latestPast,
}: {
  featured: PublicCuencada;
  latestPast: CuencadaSummary | null;
}): ReactNode {
  const place = formatPlace(featured);
  return (
    <CuencadaHero
      kicker="La próxima Cuencada"
      titleStyle="page"
      title={`Cuencada ${featured.year}`}
      lead={TAGLINE}
      imageUrl={safeAssetUrl(featured.heroImageUrl)}
      actions={
        <>
          <Button to={`/cuencada/${featured.year}`} surface="dark" icon="📅">
            Ver Cuencada {featured.year}
          </Button>
          {latestPast ? (
            <Button
              to={`/galeria/${latestPast.year}`}
              variant="secondary"
              surface="dark"
              icon="📸"
            >
              Ver recuerdos de {latestPast.year}
            </Button>
          ) : null}
        </>
      }
    >
      <p className={styles.thanks} data-testid="announced-pending">
        <span aria-hidden="true">🗓️ </span>
        {place === null
          ? DATE_AND_PLACE_TO_BE_ANNOUNCED
          : `${place} · Fecha por anunciar`}
      </p>
      <RsvpSlot year={featured.year} />
    </CuencadaHero>
  );
}

function MemoriesHero({
  latestPast,
}: { latestPast: CuencadaSummary | null }): ReactNode {
  return (
    <CuencadaHero
      kicker={
        latestPast
          ? "Gracias por una Cuencada inolvidable"
          : "Portal de la Familia Cuenca"
      }
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
            <Button
              to={`/cuencada/${latestPast.year}`}
              variant="secondary"
              surface="dark"
              icon="📅"
            >
              Ver programa {latestPast.year}
            </Button>
          </>
        ) : null
      }
    >
      <p className={styles.thanks}>
        <span aria-hidden="true">💛 </span>
        {latestPast
          ? `Gracias por acompañarnos. La ${latestPast.title}${latestPast.city ? ` en ${latestPast.city}` : ""} ya es parte de nuestra historia.`
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
function TodayMessage({
  featured,
  onNewDay,
}: { featured: PublicCuencada; onNewDay: () => void }): ReactNode {
  const today = useOnNewDay(featured.timezone, onNewDay);
  const message =
    featured.todayMessage?.date === today ? featured.todayMessage : null;
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
  const members = useListMemberAnnouncementsQuery(undefined, {
    skip: !isMember,
  });

  const byId = new Map<string, Announcement>();
  for (const announcement of [
    ...home.announcements,
    ...(isMember ? (members.data ?? []) : []),
  ]) {
    byId.set(announcement.id, announcement);
  }
  if (byId.size === 0) return null;
  return (
    <Section id="avisos" icon="📣" title="Avisos">
      <AnnouncementList
        announcements={[...byId.values()]}
        timeZone={home.featured?.timezone ?? PORTAL_TIMEZONE}
      />
    </Section>
  );
}

/** Teaser copy for visitors (family photos are members-only). */
export const PHOTOS_LOGIN_TEASER =
  "Inicia sesión para ver las fotos de la familia";
/** Teaser copy for members whose email isn't verified yet. */
export const PHOTOS_VERIFY_TEASER =
  "Verifica tu correo para ver las fotos de la familia";

/**
 * "Últimos momentos" [privacy]: family photos are members-only (owner
 * decision). Visitors get the brand art and a login teaser; members with an
 * unverified email a verify teaser; verified members the latest past
 * edition's photos through T4's `GalleryPreview` (presigned thumbnails).
 */
function MemoriesPhotos({
  latestPast,
}: { latestPast: CuencadaSummary | null }): ReactNode {
  const status = useAppSelector(selectAuthStatus);
  const user = useAppSelector(selectCurrentUser);
  const mustChange = useAppSelector(selectPasswordChangeRequired);
  const isMember = status === "authenticated" && user !== null && !mustChange;

  if (isMember && user.emailVerified) {
    return latestPast ? (
      <GalleryPreview year={latestPast.year} headingLevel={3} />
    ) : null;
  }
  return (
    <Card tone="sunken" padding="md" className={styles.photosTeaser}>
      <img
        src="/images/logo-96.webp"
        alt=""
        width={96}
        height={96}
        className={styles.teaserArt}
        loading="lazy"
        decoding="async"
      />
      <div className={styles.teaserText}>
        <p className={styles.teaserTitle}>
          {isMember ? PHOTOS_VERIFY_TEASER : PHOTOS_LOGIN_TEASER}
        </p>
        <p>
          {isMember
            ? "Abre el enlace que te enviamos por correo; si no lo encuentras, pide otro desde el aviso de arriba."
            : "Las fotos y videos de la Cuencada son privados: solo los ve la familia con cuenta."}
        </p>
        {isMember ? null : (
          <Button to="/entrar" variant="secondary" size="sm">
            Iniciar sesión
          </Button>
        )}
      </div>
    </Card>
  );
}

/** "Últimos momentos": the latest past edition's photos (members) or the login/verify teaser. */
function MemoriesPhotosSection({
  latestPast,
}: { latestPast: CuencadaSummary | null }): ReactNode {
  return (
    <Section
      id="recuerdos"
      icon="📸"
      title="Últimos momentos"
      intro="Los recuerdos de la última Cuencada, solo para la familia."
    >
      <MemoriesPhotos latestPast={latestPast} />
    </Section>
  );
}

function Memories({
  latestPast,
}: { latestPast: CuencadaSummary | null }): ReactNode {
  return (
    <>
      <MemoriesPhotosSection latestPast={latestPast} />
      <div className="cu-container">
        <Card
          tone="accent"
          icon="🗓️"
          title="La próxima Cuencada"
          className={styles.next}
        >
          <p>Todavía no tiene fecha. Te avisaremos cuando se publique.</p>
        </Card>
      </div>
    </>
  );
}

const HIGHLIGHTS = [
  {
    icon: "📅",
    title: "Programa",
    text: "Consulta cada día, horarios y actividades.",
    memberOnly: false,
    path: (year: number | null) => (year ? `/cuencada/${year}` : null),
  },
  {
    icon: "📸",
    title: "Álbum vivo",
    text: "Fotos y videos por año, privados para la familia.",
    memberOnly: true,
    path: (year: number | null) => (year ? `/galeria/${year}` : "/galeria"),
  },
  {
    icon: "🧭",
    title: "Directorio",
    text: "Perfiles familiares con privacidad para correo y teléfono.",
    memberOnly: true,
    path: () => "/directorio",
  },
  {
    icon: "🌳",
    title: "Árbol familiar",
    text: "Generaciones, parentescos e historia de la Familia Cuenca.",
    memberOnly: true,
    path: () => "/arbol",
  },
] as const;

/** The anonymous visitor's stand-in for the member-only highlights. */
export const MEMBER_TEASER_TEXT =
  "Inicia sesión para ver el directorio, el árbol familiar, las fotos y el chat";

/**
 * "Todo en un solo lugar". Members (verified or not) get every highlight;
 * anonymous visitors get the public ones plus one compact "Inicia sesión…"
 * teaser instead of links that would only bounce them to /entrar. While the
 * session restores at boot, only the public ones (no teaser flash for a
 * returning member). UX only: the server guards the member pages.
 */
function Highlights({
  featuredYear,
}: { featuredYear: number | null }): ReactNode {
  const audience = useAppSelector(selectSessionAudience);
  const isMember = audience === "member" || audience === "admin";
  const links = HIGHLIGHTS.flatMap((item) => {
    const to = item.path(featuredYear);
    return to === null || (item.memberOnly && !isMember)
      ? []
      : [{ ...item, to }];
  });
  return (
    <Section id="todo" title="Todo en un solo lugar">
      <ul className={styles.highlights}>
        {links.map((item) => (
          <li key={item.title}>
            <Link to={item.to} className={styles.highlight}>
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
        ))}
        {audience === "anonymous" ? (
          <li
            className={
              links.length === 0 ? styles.teaserAlone : styles.teaserItem
            }
          >
            <div className={styles.teaser}>
              <span aria-hidden="true" className={styles.highlightIcon}>
                🔒
              </span>
              <p className={styles.teaserText}>{MEMBER_TEASER_TEXT}</p>
              <Button to="/entrar" className={styles.teaserAction}>
                Entrar
              </Button>
            </div>
          </li>
        ) : null}
      </ul>
    </Section>
  );
}

/** "Cuencadas anteriores": past published editions as chips. */
function PastEditions(): ReactNode {
  const list = useListCuencadasQuery();
  const past = (list.data ?? []).filter(
    (cuencada) => cuencada.status === "past",
  );
  if (past.length === 0) return null;
  return (
    <Section id="anteriores" icon="📜" title="Cuencadas anteriores">
      <ul className={styles.editions}>
        {past.map((cuencada) => (
          <li key={cuencada.id}>
            <Link to={`/cuencada/${cuencada.year}`} className={styles.edition}>
              <strong>{cuencada.year}</strong>
              {cuencada.city ? ` · ${cuencada.city}` : null}
            </Link>
          </li>
        ))}
      </ul>
    </Section>
  );
}
