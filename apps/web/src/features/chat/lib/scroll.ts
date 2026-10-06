/**
 * Auto-scroll rules for the message list, kept pure so they are unit tested.
 */

/** Within this many px of the bottom counts as "at the bottom". */
export const NEAR_BOTTOM_PX = 96;
/** Within this many px of the top triggers loading older messages. */
export const NEAR_TOP_PX = 48;

/** Scroll metrics of the list element. */
export interface ScrollMetrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

/**
 * @param metrics - The list's scroll metrics.
 * @param threshold - Tolerance in px.
 * @returns Whether the user is at (or near) the newest message.
 */
export function isNearBottom(metrics: ScrollMetrics, threshold = NEAR_BOTTOM_PX): boolean {
  return metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight <= threshold;
}

/** First/last message ids rendered, used to tell appends from prepends. */
export interface ListEdges {
  firstId: string | null;
  lastId: string | null;
  count: number;
}

/** Inputs of {@link decideScroll}. */
export interface ScrollDecisionInput {
  previous: ListEdges;
  next: ListEdges;
  /** Whether the list was near the bottom before the change. */
  wasNearBottom: boolean;
  /** Whether the newest message is mine (I just sent it). */
  newestIsMine: boolean;
}

/**
 * What to do after the rendered messages change:
 * - `bottom`: jump to the newest message (first render, I sent it, or I was already at the bottom)
 * - `preserve`: older messages were added on top; keep what I was reading in place
 * - `pill`: someone else wrote while I was reading history; show "Nuevos mensajes ↓"
 * - `none`: nothing new at either end (e.g. a tombstone)
 */
export type ScrollDecision = "bottom" | "preserve" | "pill" | "none";

/**
 * @param input - The list before and after the change.
 * @returns The scroll action.
 */
export function decideScroll({ previous, next, wasNearBottom, newestIsMine }: ScrollDecisionInput): ScrollDecision {
  if (next.count === 0) return "none";
  if (previous.count === 0) return "bottom";
  const appended = next.lastId !== previous.lastId;
  const prepended = next.firstId !== previous.firstId && !appended;
  if (prepended) return "preserve";
  if (!appended) return "none";
  if (newestIsMine || wasNearBottom) return "bottom";
  return "pill";
}
