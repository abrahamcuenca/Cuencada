import { type DirectoryEntry, idSchema } from "@cuencada/types";
import { type ReactNode, useEffect, useRef } from "react";
import { getApiErrorCode, isAbortError } from "../../../shared/api/errors";
import { AvatarCircle } from "../../../shared/ui/AvatarCircle";
import { Button } from "../../../shared/ui/Button";
import { EmptyState } from "../../../shared/ui/EmptyState";
import { Skeleton } from "../../../shared/ui/Skeleton";
import { useExpiredUrlRefetch } from "../../gallery";
import { useGetDirectoryEntryQuery } from "../api";
import { mailtoHref, telHref, whatsappHref } from "../lib/contactLinks";
import styles from "../directory.module.css";
import { DirectoryError } from "./AccessStates";
import { ContactList } from "./ContactList";

/**
 * One member's card (`GET /directory/:userId`). Shows only the fields the
 * response carries: hidden contact fields are absent, and so are their buttons.
 * Servers from WP-4.4 send `contacts` (server-built links), listed with
 * {@link ContactList}; the legacy phone/email buttons remain only for older
 * responses without it.
 */
export function DirectoryDetail({ userId }: { userId: string }): ReactNode {
  // [SEC] The route param is untrusted: only a UUID is ever put in the request path.
  const validId = idSchema.safeParse(userId).success;
  const { currentData: data, error, isLoading, refetch } = useGetDirectoryEntryQuery(userId, { skip: !validId });
  // The avatar URL is a 1h presigned GET: when it fails to load, refetch the entry once.
  const onImageError = useExpiredUrlRefetch(refetch);

  if (!validId) return <NotFound />;
  if (data) return <EntryCard key={data.userId} entry={data} onImageError={onImageError} />;
  if (error && !isAbortError(error)) {
    if (getApiErrorCode(error) === "NOT_FOUND") return <NotFound />;
    return <DirectoryError error={error} onRetry={() => void refetch()} />;
  }
  return (
    <div className={styles.detailSkeleton} aria-busy={isLoading}>
      <Skeleton shape="circle" width={96} height={96} />
      <Skeleton shape="text" width="60%" />
      <Skeleton shape="text" width="40%" />
    </div>
  );
}

/** Unknown, hidden or malformed member id. */
function NotFound(): ReactNode {
  return (
    <EmptyState
      icon="🔎"
      title="No encontramos a este familiar"
      description="Puede que haya ocultado su ficha del directorio."
      action={
        <Button variant="secondary" to="/directorio">
          Volver al directorio
        </Button>
      }
    />
  );
}

/** Under "Llamar" when the number has no country code (so no WhatsApp link). */
export const NO_COUNTRY_CODE_NOTE = "Este número no tiene código de país, así que no podemos abrirlo en WhatsApp.";

/** Under "Contacto" when the member shows no contact. */
export const NO_CONTACTS_TEXT = "No comparte datos de contacto.";

function EntryCard({ entry, onImageError }: { entry: DirectoryEntry; onImageError: () => void }): ReactNode {
  const heading = useRef<HTMLHeadingElement>(null);
  const name = entry.fullName || entry.displayName;
  const card = entry.contacts;
  // Legacy fields only when the server sent no card (pre-WP-4.4 responses).
  const phone = card === undefined ? entry.phone : undefined;
  const email = card === undefined ? entry.email : undefined;
  const call = phone === undefined ? null : telHref(phone);
  const whatsapp = phone === undefined ? null : whatsappHref(phone);
  const mail = email === undefined ? null : mailtoHref(email);

  // Move focus to the person when the detail opens (it replaces the list on phones).
  useEffect(() => {
    heading.current?.focus();
  }, []);

  return (
    <article className={styles.detail} aria-labelledby={`persona-${entry.userId}`} onError={onImageError}>
      <AvatarCircle name={name} src={entry.avatarUrl ?? undefined} size="xl" decorative />
      <h2 ref={heading} id={`persona-${entry.userId}`} className={styles.detailName} tabIndex={-1}>
        {name}
      </h2>
      {entry.displayName && entry.displayName !== name ? <p className={styles.detailMeta}>Le dicen {entry.displayName}</p> : null}

      <dl className={styles.facts}>
        {entry.familyBranch ? (
          <div>
            <dt>Rama familiar</dt>
            <dd>{entry.familyBranch}</dd>
          </div>
        ) : null}
        {entry.city !== undefined ? (
          <div>
            <dt>Ciudad</dt>
            <dd>{entry.city}</dd>
          </div>
        ) : null}
        {phone !== undefined ? (
          <div>
            <dt>Teléfono</dt>
            <dd translate="no">{phone}</dd>
          </div>
        ) : null}
        {email !== undefined ? (
          <div>
            <dt>Correo</dt>
            <dd translate="no" className={styles.email}>
              {email}
            </dd>
          </div>
        ) : null}
      </dl>

      {entry.bio ? <p className={styles.bio}>{entry.bio}</p> : null}

      {card !== undefined ? (
        <section className={styles.contacts} aria-labelledby={`contacto-${entry.userId}`}>
          <h3 id={`contacto-${entry.userId}`} className={styles.contactsTitle}>
            Contacto
          </h3>
          <ContactList contacts={card} ownerName={entry.displayName || name} emptyText={NO_CONTACTS_TEXT} />
        </section>
      ) : null}

      {call !== null || whatsapp !== null || mail !== null ? (
        <div className={styles.actions}>
          {whatsapp !== null && phone !== undefined ? (
            <Button variant="whatsapp" href={whatsapp} external icon="💬" fullWidth>
              WhatsApp <span translate="no">{phone}</span>
            </Button>
          ) : null}
          {call !== null && phone !== undefined ? (
            <Button variant="secondary" href={call} icon="📞" fullWidth>
              Llamar al <span translate="no">{phone}</span>
            </Button>
          ) : null}
          {call !== null && whatsapp === null ? <p className={styles.contactNote}>{NO_COUNTRY_CODE_NOTE}</p> : null}
          {mail !== null ? (
            <Button variant="secondary" href={mail} icon="✉️" fullWidth>
              Correo
            </Button>
          ) : null}
        </div>
      ) : null}

      {entry.personId !== null ? (
        <Button variant="ghost" to={`/arbol/${entry.personId}`} icon="🌳" iconEnd="›">
          Ver en el árbol
        </Button>
      ) : null}
    </article>
  );
}
