import type { MemberCuencadaDetails } from "@cuencada/types";
import type { ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { Button } from "../../../shared/ui/Button";
import { EmptyState } from "../../../shared/ui/EmptyState";
import type { AccessDenial } from "../../auth/accessDenied";
import { AccessDeniedState } from "../../auth/components/AccessDeniedState";
import { Skeleton } from "../../../shared/ui/Skeleton";
import { safeHttpsUrl } from "../lib/format";
import { AnnouncementList } from "./AnnouncementList";
import { Section } from "./Section";
import { AttendeesSlot, GalleryPreviewSlot, RsvpSlot } from "./slots";
import styles from "./content.module.css";

/** What the members-only block can show. */
export type MembersBlockState =
  | { kind: "checking" }
  | { kind: "anonymous" }
  | { kind: "loading" }
  | { kind: "unavailable"; offline: boolean; retry: () => void }
  /** 403 from `/members` (WP-2.3 M2: verified email required). Retrying cannot help, so no retry. */
  | { kind: "denied"; denial: AccessDenial }
  | { kind: "member"; details: MemberCuencadaDetails };

/** Props for {@link MembersBlock}. */
export interface MembersBlockProps {
  year: number;
  timeZone: string;
  state: MembersBlockState;
}

/**
 * The members-only part of `/cuencada/:year`.
 * - Visitors see the lock card ("Inicia sesión para ver fotos, asistentes y
 *   más") with a link to `/entrar` that returns here after login.
 * - Members see the WhatsApp group, the shared album, members-only
 *   announcements, and the T3/T4 slots (RSVP, attendees, gallery).
 *
 * Hiding this block is UX only: the API never sends members-only data to
 * anonymous requests.
 */
export function MembersBlock({ year, timeZone, state }: MembersBlockProps): ReactNode {
  return (
    <Section id="familia" icon="👨‍👩‍👧‍👦" title="Para la familia">
      <MembersBlockBody year={year} timeZone={timeZone} state={state} />
    </Section>
  );
}

function MembersBlockBody({ year, timeZone, state }: MembersBlockProps): ReactNode {
  const location = useLocation();

  switch (state.kind) {
    case "checking":
    case "loading":
      return (
        <div className={styles.membersLoading}>
          <Skeleton shape="block" height="9rem" />
          <span className="visually-hidden">Cargando la sección de la familia…</span>
        </div>
      );
    case "anonymous":
      return (
        <EmptyState
          tone="lock"
          icon="🔒"
          headingLevel={3}
          title="Solo para la familia"
          description="Inicia sesión para ver fotos, asistentes y más."
          action={
            <div className={styles.lockActions}>
              <Button to="/entrar" state={{ from: `${location.pathname}${location.search}` }}>
                Entrar
              </Button>
              <Button to="/invitacion" variant="secondary">
                Tengo una invitación
              </Button>
            </div>
          }
        />
      );
    case "unavailable":
      return (
        <EmptyState
          icon={state.offline ? "📴" : "⚠️"}
          headingLevel={3}
          title={state.offline ? "Sin conexión" : "No pudimos cargar esta sección"}
          description={
            state.offline
              ? "Necesitas conexión para ver la sección de la familia."
              : "Inténtalo de nuevo en un momento."
          }
          action={
            <Button variant="secondary" onClick={state.retry}>
              Reintentar
            </Button>
          }
        />
      );
    case "denied":
      return (
        <AccessDeniedState
          denial={state.denial}
          headingLevel={3}
          verifyTitle="Verifica tu correo para ver la sección de la familia"
          verifyDescription="El grupo de WhatsApp, el álbum, las fotos y quién va son solo para la familia. Abre el enlace que te enviamos por correo para confirmar que eres tú; si no lo encuentras, pide otro."
          forbiddenTitle="No tienes acceso a la sección de la familia"
        />
      );
    case "member":
      return <MemberContent year={year} timeZone={timeZone} details={state.details} />;
  }
}

function MemberContent({ year, timeZone, details }: { year: number; timeZone: string; details: MemberCuencadaDetails }): ReactNode {
  const whatsappUrl = safeHttpsUrl(details.whatsappUrl);
  const albumUrl = safeHttpsUrl(details.externalAlbumUrl);
  const memberAnnouncements = details.announcements.filter((announcement) => announcement.visibility === "members");

  return (
    <div className={styles.members}>
      {whatsappUrl || albumUrl ? (
        <div className={styles.linkRow}>
          {whatsappUrl ? (
            <Button href={whatsappUrl} external variant="whatsapp" icon="💬">
              Grupo WhatsApp
            </Button>
          ) : null}
          {albumUrl ? (
            <Button href={albumUrl} external variant="secondary" icon="📸" iconEnd="↗">
              Ver álbum compartido
            </Button>
          ) : null}
        </div>
      ) : null}
      <div className={styles.slots}>
        <RsvpSlot year={year} />
        <AttendeesSlot year={year} />
        <GalleryPreviewSlot year={year} />
      </div>
      {memberAnnouncements.length > 0 ? (
        <div>
          <h3 className={styles.subTitle}>
            <span aria-hidden="true">📣 </span>Avisos para la familia
          </h3>
          <AnnouncementList announcements={memberAnnouncements} timeZone={timeZone} headingLevel={4} />
        </div>
      ) : null}
    </div>
  );
}
