import type { Announcement } from "@cuencada/types";
import type { ReactNode } from "react";
import { formatDate } from "../../../shared/lib/dates";
import { Badge } from "../../../shared/ui/Badge";
import { Card } from "../../../shared/ui/Card";
import { LinkifiedText } from "./LinkifiedText";
import styles from "./content.module.css";

/** Props for {@link AnnouncementList}. */
export interface AnnouncementListProps {
  announcements: readonly Announcement[];
  /** Timezone used for the "publicado" date (the Cuencada's, or the portal default). */
  timeZone: string;
  headingLevel?: 3 | 4;
}

/** Pinned first, then newest first. */
function sortAnnouncements(announcements: readonly Announcement[]): Announcement[] {
  return [...announcements].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return Date.parse(b.publishedAt) - Date.parse(a.publishedAt);
  });
}

/**
 * Announcement cards ("Avisos"): title, pinned/members badges, body with
 * clickable https links, and the publish date in the Cuencada's timezone.
 */
export function AnnouncementList({ announcements, timeZone, headingLevel = 3 }: AnnouncementListProps): ReactNode {
  if (announcements.length === 0) return null;
  const Heading = headingLevel === 3 ? "h3" : "h4";
  return (
    <ul className={styles.announcements}>
      {sortAnnouncements(announcements).map((announcement) => (
        <Card as="li" key={announcement.id} tone={announcement.pinned ? "accent" : "default"} className={styles.announcement}>
          <div className={styles.announcementHeader}>
            <Heading className={styles.announcementTitle}>
              {announcement.pinned ? <span aria-hidden="true">📌 </span> : null}
              {announcement.title}
            </Heading>
            {announcement.visibility === "members" ? <Badge tone="brand">Solo familia</Badge> : null}
          </div>
          <p className={styles.announcementBody}>
            <LinkifiedText text={announcement.body} />
          </p>
          <p className={styles.meta}>
            Publicado el {formatDate(announcement.publishedAt, timeZone)}
            {announcement.authorName ? ` · ${announcement.authorName}` : null}
          </p>
        </Card>
      ))}
    </ul>
  );
}
