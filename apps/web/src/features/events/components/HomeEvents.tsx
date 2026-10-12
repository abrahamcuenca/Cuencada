import type { ReactNode } from "react";
import styles from "../events.module.css";
import { EventNotices } from "../notices/AddedToEventNotice";
import { UpcomingEventsStrip } from "./UpcomingEventsStrip";

/**
 * Home's events block (WP-5.4, members, one lazy chunk): the "Te agregaron
 * a…" notices, then the "Próximos eventos" strip. Each renders nothing when
 * empty, loading or failing.
 */
export function HomeEvents(): ReactNode {
  return (
    <>
      <div className={`cu-container ${styles.homeNotices}`}>
        <EventNotices />
      </div>
      <UpcomingEventsStrip />
    </>
  );
}
