import { hasDates, type PublicCuencada, yearParamSchema } from "@cuencada/types";
import { type ReactNode, useEffect } from "react";
import { useLocation, useParams } from "react-router-dom";
import { useAppSelector } from "../../../app/hooks";
import { isFetchBaseQueryError } from "../../../shared/api/errors";
import { Button } from "../../../shared/ui/Button";
import { Countdown } from "../../../shared/ui/Countdown";
import { useAccessDenial } from "../../auth/accessDenied";
import { selectAuthStatus, selectCurrentUser, selectPasswordChangeRequired } from "../../auth/authSlice";
import { useGetCuencadaMembersQuery, useGetCuencadaQuery } from "../api";
import { AnnouncementList } from "../components/AnnouncementList";
import { CuencadaHero } from "../components/CuencadaHero";
import { CuencadaNotFound, LoadErrorState, OfflineNotice, PageSkeleton } from "../components/PageStates";
import { DailyMessageCard } from "../components/DailyMessageCard";
import { LocationCards } from "../components/LocationCards";
import { MembersBlock, type MembersBlockState } from "../components/MembersBlock";
import { ProgramaTimeline } from "../components/ProgramaTimeline";
import { Section } from "../components/Section";
import { SongPlayer } from "../components/SongPlayer";
import { forecastUrl, WeatherWidget } from "../components/WeatherWidget";
import styles from "../components/content.module.css";
import { useNow } from "../hooks/useNow";
import { useOnNewDay } from "../hooks/useZonedToday";
import { countdownInstants, formatEditionDates, formatKicker, formatPlace, idFromHash, safeAssetUrl, TO_BE_ANNOUNCED } from "../lib/format";

/**
 * Parses the `:year` route param with the contract schema.
 *
 * @param raw - The URL segment.
 * @returns The year, or `null` when it is not a valid year.
 */
function parseYear(raw: string | undefined): number | null {
  const parsed = yearParamSchema.safeParse({ year: raw });
  return parsed.success ? parsed.data.year : null;
}

/**
 * `/cuencada/:year`: the partially public edition page, ported from the
 * legacy `index.html` (hero, mensaje del día, programa, ¿dónde estamos?,
 * clima, canción) plus the members-only block.
 *
 * Offline: the public response is cached by the PWA (T9). When a refetch
 * fails, RTK Query keeps the last data, so the page keeps rendering it with a
 * "Sin conexión" note instead of an error.
 */
export function CuencadaYearPage(): ReactNode {
  const year = parseYear(useParams().year);
  const query = useGetCuencadaQuery(year ?? 0, { skip: year === null });
  const members = useMembersState(year);

  if (year === null) return <CuencadaNotFound />;
  if (query.data === undefined) {
    if (query.error === undefined) return <PageSkeleton />;
    if (isFetchBaseQueryError(query.error) && query.error.status === 404) return <CuencadaNotFound />;
    return <LoadErrorState error={query.error} onRetry={() => void query.refetch()} />;
  }

  return (
    <CuencadaYearContent
      cuencada={query.data}
      members={members}
      stale={query.error !== undefined}
      onRetry={() => void query.refetch()}
    />
  );
}

/** Decides what the members block shows from the session and the members query. */
function useMembersState(year: number | null): MembersBlockState {
  const status = useAppSelector(selectAuthStatus);
  const user = useAppSelector(selectCurrentUser);
  const mustChange = useAppSelector(selectPasswordChangeRequired);
  const isMember = status === "authenticated" && user !== null && !mustChange;
  const query = useGetCuencadaMembersQuery(year ?? 0, { skip: !isMember || year === null });
  // A 403 (unverified email or no access) is final: show why instead of a retry that cannot succeed.
  const denial = useAccessDenial(query.error);

  if (status === "idle" || status === "restoring") return { kind: "checking" };
  if (!isMember) return { kind: "anonymous" };
  if (query.data !== undefined) return { kind: "member", details: query.data };
  if (denial !== null) return { kind: "denied", denial };
  if (query.error !== undefined) {
    const offline = isFetchBaseQueryError(query.error) && query.error.status === "FETCH_ERROR";
    return { kind: "unavailable", offline, retry: () => void query.refetch() };
  }
  return { kind: "loading" };
}

/** Scrolls to `#programa` (etc.) once the content exists, e.g. after "Ver programa" on Home. */
function useScrollToHash(ready: boolean): void {
  const { hash } = useLocation();
  useEffect(() => {
    const id = ready ? idFromHash(hash) : null;
    if (id === null) return;
    document.getElementById(id)?.scrollIntoView();
  }, [ready, hash]);
}

interface ContentProps {
  cuencada: PublicCuencada;
  members: MembersBlockState;
  stale: boolean;
  onRetry: () => void;
}

function CuencadaYearContent({ cuencada, members, stale, onRetry }: ContentProps): ReactNode {
  const now = useNow(cuencada.endsAt);
  useScrollToHash(true);
  const details = members.kind === "member" ? members.details : null;
  // Members get every item (public + members-only); visitors only the public ones.
  const itinerary = details?.itinerary ?? cuencada.publicItinerary;
  const locations = details?.locations ?? cuencada.publicLocations;
  // After local midnight the server has the new day's message: refetch the page data.
  const today = useOnNewDay(cuencada.timezone, onRetry);
  const todayMessage = cuencada.todayMessage?.date === today ? cuencada.todayMessage : null;
  // The weather widget needs a place; without one there is no forecast to show.
  const weatherUrl = cuencada.city === null ? null : forecastUrl(cuencada.weatherWidgetUrl);
  const songUrl = safeAssetUrl(cuencada.songUrl);
  // An announced edition (no dates yet) hides the programa and places until there is something in them.
  const dated = hasDates(cuencada);
  const showPrograma = dated || itinerary.length > 0;
  const showLugares = dated || locations.length > 0;

  const sectionLinks = [
    ...(showPrograma ? [{ id: "programa", label: "Programa" }] : []),
    ...(showLugares ? [{ id: "lugares", label: "Lugares" }] : []),
    ...(weatherUrl ? [{ id: "clima", label: "Clima" }] : []),
    ...(songUrl ? [{ id: "cancion", label: "Canción" }] : []),
    { id: "familia", label: "Familia" }
  ];

  return (
    <>
      <CuencadaHero
        kicker={formatKicker(cuencada)}
        titleStyle="page"
        title={cuencada.title}
        lead={cuencada.description}
        imageUrl={safeAssetUrl(cuencada.heroImageUrl)}
        actions={
          showPrograma || showLugares ? (
            <>
              {showPrograma ? (
                <Button href="#programa" surface="dark" icon="📅">
                  Ver programa
                </Button>
              ) : null}
              {showLugares ? (
                <Button href="#lugares" variant="secondary" surface="dark" icon="🗺️">
                  Ver lugares
                </Button>
              ) : null}
            </>
          ) : null
        }
      >
        {hasDates(cuencada) ? (
          <Countdown
            {...countdownInstants(cuencada.status, cuencada.startsAt, cuencada.endsAt, now)}
            pastMessage={`La Cuencada ${cuencada.year}${cuencada.city ? ` en ${cuencada.city}` : ""} ya es parte de nuestra historia. ¡Gracias por acompañarnos!`}
          />
        ) : (
          <PendingFacts cuencada={cuencada} />
        )}
      </CuencadaHero>

      <div className="cu-container">
        {stale ? <OfflineNotice onRetry={onRetry} /> : null}
        {todayMessage ? <DailyMessageCard message={todayMessage} timeZone={cuencada.timezone} /> : null}
        <nav aria-label="Secciones de la Cuencada" className={styles.sectionNav}>
          <ul className={styles.sectionNavList}>
            {sectionLinks.map((link) => (
              <li key={link.id}>
                <a className={styles.sectionNavLink} href={`#${link.id}`}>
                  {link.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      </div>

      {cuencada.publicAnnouncements.length > 0 ? (
        <Section id="avisos" icon="📣" title="Avisos">
          <AnnouncementList announcements={cuencada.publicAnnouncements} timeZone={cuencada.timezone} />
        </Section>
      ) : null}

      {showPrograma ? (
        <Section id="programa" icon="📅" title={`Programa ${cuencada.title}`}>
          <ProgramaTimeline items={itinerary} timeZone={cuencada.timezone} />
        </Section>
      ) : null}

      {showLugares ? (
        <Section id="lugares" icon="🗺️" title="¿Dónde estamos?" intro="Accesos rápidos a hoteles y lugares del recorrido.">
          <LocationCards locations={locations} />
        </Section>
      ) : null}

      {weatherUrl || songUrl ? (
        <div className={`cu-container ${styles.media}`}>
          {weatherUrl && cuencada.city !== null ? (
            <section id="clima" aria-labelledby="clima-titulo" className={styles.section}>
              <h2 id="clima-titulo" className={styles.sectionTitle}>
                <span aria-hidden="true">🌤️ </span>Clima en {cuencada.city}
              </h2>
              <WeatherWidget href={weatherUrl} city={cuencada.city} state={cuencada.state ?? ""} />
            </section>
          ) : null}
          {songUrl ? (
            <section id="cancion" aria-labelledby="cancion-titulo" className={styles.section}>
              <h2 id="cancion-titulo" className={styles.sectionTitle}>
                <span aria-hidden="true">🎵 </span>Nuestra canción
              </h2>
              <SongPlayer src={songUrl} title={cuencada.title} />
            </section>
          ) : null}
        </div>
      ) : null}

      <MembersBlock year={cuencada.year} timeZone={cuencada.timezone} state={members} />
    </>
  );
}

/**
 * In place of the countdown while the edition has no dates (status
 * `announced`): "Fechas" and "Lugar", each "Por anunciar" until it is set.
 */
function PendingFacts({ cuencada }: { cuencada: PublicCuencada }): ReactNode {
  return (
    <dl className={styles.pendingFacts} data-testid="pending-facts">
      <div className={styles.pendingFact}>
        <dt>Fechas:</dt>
        <dd>{formatEditionDates(cuencada)}</dd>
      </div>
      <div className={styles.pendingFact}>
        <dt>Lugar:</dt>
        <dd>{formatPlace(cuencada) ?? TO_BE_ANNOUNCED}</dd>
      </div>
    </dl>
  );
}
