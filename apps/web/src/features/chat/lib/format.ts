/**
 * Chat date labels and message grouping (es-MX).
 *
 * Chat timestamps use the **reader's** timezone, unlike the programa (which
 * always uses the Cuencada's timezone): a message sent "a las 9" should read
 * as 9 for whoever is reading it, like any messaging app. The timezone is a
 * parameter everywhere, so tests pin it.
 */
import { formatDate, formatTime, toZonedParts } from "../../../shared/lib/dates";
import type { ThreadMessage } from "./thread";

/** Consecutive messages from the same person within this window share one group. */
export const GROUP_WINDOW_MS = 5 * 60_000;

/** @returns The device's IANA timezone (falls back to UTC). */
export function readerTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function dayNumber(value: Date | string, timeZone: string): number {
  const parts = toZonedParts(value, timeZone);
  return Date.UTC(parts.year, parts.month - 1, parts.day) / 86_400_000;
}

function capitalize(text: string): string {
  return text.charAt(0).toLocaleUpperCase("es-MX") + text.slice(1);
}

/**
 * @param value - An instant.
 * @param now - The current time.
 * @param timeZone - The reader's timezone.
 * @returns The day separator: "Hoy", "Ayer", "Lunes 14 de septiembre" (plus the year when it is not this year).
 */
export function dayLabel(value: string, now: Date, timeZone: string): string {
  const diff = dayNumber(now, timeZone) - dayNumber(value, timeZone);
  if (diff === 0) return "Hoy";
  if (diff === 1) return "Ayer";
  const sameYear = toZonedParts(value, timeZone).year === toZonedParts(now, timeZone).year;
  const options: Intl.DateTimeFormatOptions = sameYear
    ? { weekday: "long", day: "numeric", month: "long" }
    : { weekday: "long", day: "numeric", month: "long", year: "numeric" };
  return capitalize(formatDate(value, timeZone, options).replace(",", ""));
}

/**
 * @param value - An instant.
 * @param timeZone - The reader's timezone.
 * @returns The bubble time, e.g. "9:41 a.m.".
 */
export function messageTime(value: string, timeZone: string): string {
  return formatTime(value, timeZone);
}

/**
 * @param value - The room's `lastMessageAt`.
 * @param now - The current time.
 * @param timeZone - The reader's timezone.
 * @returns "9:41 a.m." today, "ayer", a weekday this week ("lun"), else a short date ("14 sept").
 */
export function roomTimeLabel(value: string, now: Date, timeZone: string): string {
  const diff = dayNumber(now, timeZone) - dayNumber(value, timeZone);
  if (diff <= 0) return formatTime(value, timeZone);
  if (diff === 1) return "ayer";
  if (diff < 7) return formatDate(value, timeZone, { weekday: "short" }).replace(".", "");
  const sameYear = toZonedParts(value, timeZone).year === toZonedParts(now, timeZone).year;
  return formatDate(value, timeZone, sameYear ? { day: "numeric", month: "short" } : { day: "numeric", month: "short", year: "numeric" }).replace(
    ".",
    ""
  );
}

/** One row of the rendered conversation. */
export type ConversationItem =
  | { kind: "day"; key: string; label: string }
  | { kind: "unread"; key: string }
  | {
      kind: "message";
      key: string;
      message: ThreadMessage;
      mine: boolean;
      /** First bubble of a sender group: shows the name and avatar. */
      groupStart: boolean;
      /** Last bubble of a group: shows the time. */
      groupEnd: boolean;
    };

/** Options for {@link buildConversation}. */
export interface ConversationOptions {
  meId: string | null;
  now: Date;
  timeZone: string;
  /** Show "Nuevos mensajes" before this message (the first unread one), if rendered. */
  firstUnreadId: string | null;
}

function sameGroup(previous: ThreadMessage, next: ThreadMessage, timeZone: string): boolean {
  if (previous.sender === null || next.sender === null) return false;
  if (previous.sender.userId !== next.sender.userId) return false;
  if (Date.parse(next.createdAt) - Date.parse(previous.createdAt) > GROUP_WINDOW_MS) return false;
  return dayNumber(previous.createdAt, timeZone) === dayNumber(next.createdAt, timeZone);
}

/**
 * Turns messages into render rows: day separators, the unread marker and
 * bubbles grouped by sender and time.
 *
 * @param messages - Messages oldest → newest.
 * @param options - Who I am, the clock, the reader's timezone and the unread marker.
 * @returns The rows to render.
 */
export function buildConversation(messages: readonly ThreadMessage[], options: ConversationOptions): ConversationItem[] {
  const items: ConversationItem[] = [];
  let previousDay: number | null = null;
  messages.forEach((message, index) => {
    const day = dayNumber(message.createdAt, options.timeZone);
    if (day !== previousDay) {
      items.push({ kind: "day", key: `day-${day}`, label: dayLabel(message.createdAt, options.now, options.timeZone) });
      previousDay = day;
    }
    if (message.id === options.firstUnreadId) items.push({ kind: "unread", key: "unread" });
    const before = messages[index - 1];
    const after = messages[index + 1];
    const startsGroup = before === undefined || !sameGroup(before, message, options.timeZone) || message.id === options.firstUnreadId;
    const endsGroup = after === undefined || !sameGroup(message, after, options.timeZone) || after.id === options.firstUnreadId;
    items.push({
      kind: "message",
      key: message.clientMessageId ?? message.id,
      message,
      mine: message.sender !== null && message.sender.userId === options.meId,
      groupStart: startsGroup,
      groupEnd: endsGroup
    });
  });
  return items;
}
