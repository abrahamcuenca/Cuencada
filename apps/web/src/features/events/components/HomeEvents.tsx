import type { ReactNode } from "react";
import { UpcomingEventsStrip } from "./UpcomingEventsStrip";

/**
 * Home's events block (WP-5.4, members, one lazy chunk): the "Próximos
 * eventos" strip; renders nothing when empty, loading or failing. WP-6.1
 * moved the "Te agregaron a…" notices to the notifications bell.
 */
export function HomeEvents(): ReactNode {
  return <UpcomingEventsStrip />;
}
