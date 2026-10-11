/**
 * Server-side limits of the events module (ADR 0001 §7, Security
 * requirement 2). Contract limits (participants, albums, slug attempts) live
 * in `@cuencada/types`.
 */
import type { RateLimitWindow } from "../../lib/rateLimit.js";

/** Events one member may create per rolling day (admins exempt). */
export const EVENT_CREATE_DAILY_MAX = 10;
/** The rolling window of {@link EVENT_CREATE_DAILY_MAX}. */
export const EVENT_CREATE_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Drafts one member may keep open at once (admins exempt). */
export const EVENT_OPEN_DRAFTS_MAX = 20;

/**
 * Participant writes per user (join, leave, add, role change, remove; one
 * shared counter across those routes).
 */
export const EVENT_PARTICIPANT_WRITE_LIMIT: RateLimitWindow = { max: 100, timeWindow: "1 hour" };
/** Event edits (update, delete, albums) per user. */
export const EVENT_WRITE_LIMIT: RateLimitWindow = { max: 120, timeWindow: "1 hour" };
/** Album upload intents per user (the shared daily byte budget applies on top). */
export const EVENT_UPLOAD_INTENT_LIMIT: RateLimitWindow = { max: 60, timeWindow: "1 hour" };
