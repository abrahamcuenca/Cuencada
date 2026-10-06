/**
 * Splits chat text into plain-text and link segments [SEC].
 *
 * Only `http://` and `https://` URLs become links, and only after `new URL`
 * accepts them; everything else (including `javascript:`, `data:` and
 * `www.` without a scheme) stays text. The caller renders segments as React
 * text and `<a>` elements, never as HTML.
 *
 * Anti-spoofing: the **visible** text of a link is rebuilt from the parsed
 * URL, so it shows where the link really goes: the host in ASCII
 * (punycode for internationalized lookalikes) and the percent-encoded path,
 * truncated when long. URLs that contain invisible or bidi-control
 * characters are never linkified, and ideographic full stops are
 * normalized before parsing so the shown host matches the target.
 */

/** A piece of a message body. `title` carries the full ASCII URL of a link. */
export type TextSegment = { kind: "text"; text: string } | { kind: "link"; text: string; href: string; title: string };

/** Candidate URLs: a scheme, then anything up to whitespace or characters that cannot end a URL in prose. */
const URL_CANDIDATE = /\bhttps?:\/\/[^\s<>"'`]+/gi;
/** Punctuation that usually ends a sentence rather than the URL. */
const TRAILING = /[.,;:!?¡¿)\]}»”’]+$/u;
/** Zero-width, bidi-control and BOM characters: a URL containing any of them is not linkified. */
const INVISIBLE_OR_BIDI = /[​-‏‪-‮⁦-⁩﻿]/u;
/** Ideographic, fullwidth and halfwidth full stops (。．｡), which IDNA maps to ".". */
const IDEOGRAPHIC_DOTS = /[。．｡]/gu;
/** Longest visible link text before it is cut with "…". */
export const LINK_TEXT_MAX = 60;

function trimTrailing(candidate: string): string {
  let url = candidate;
  const match = TRAILING.exec(url);
  if (match === null) return url;
  url = url.slice(0, match.index);
  // Keep a closing parenthesis that balances one inside the URL (Wikipedia-style links).
  const removed = match[0];
  let opens = (url.match(/\(/g) ?? []).length - (url.match(/\)/g) ?? []).length;
  for (const char of removed) {
    if (char === ")" && opens > 0) {
      url += char;
      opens -= 1;
    } else {
      break;
    }
  }
  return url;
}

function parseSafe(candidate: string): URL | null {
  if (INVISIBLE_OR_BIDI.test(candidate)) return null;
  let url: URL;
  try {
    url = new URL(candidate.replace(IDEOGRAPHIC_DOTS, "."));
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  // `https://user:pass@host` is a classic phishing disguise.
  if (url.username !== "" || url.password !== "") return null;
  return url;
}

/**
 * @param candidate - Text that looks like a URL.
 * @returns The normalised ASCII `href` when it is a safe http(s) URL, else `null`.
 */
export function safeHref(candidate: string): string | null {
  return parseSafe(candidate)?.href ?? null;
}

/**
 * The text shown for a link, built from the parsed URL (never the typed text).
 *
 * @param url - The parsed URL.
 * @param typed - What the user typed (only decides whether a bare "/" path is shown).
 * @returns e.g. `https://xn--pple-43d.com/login`, cut to {@link LINK_TEXT_MAX} with "…".
 */
export function linkText(url: URL, typed: string): string {
  const bareRoot = url.pathname === "/" && url.search === "" && url.hash === "" && !typed.endsWith("/");
  const prefix = `${url.protocol}//${displayHost(url.host)}`;
  const rest = bareRoot ? "" : `${url.pathname}${url.search}${url.hash}`;
  // [SEC] Only the path/query/fragment is ever cut: the host (or its registrable end) always stays visible.
  const room = Math.max(LINK_TEXT_MAX - prefix.length, 2);
  return rest.length > room ? `${prefix}${rest.slice(0, room - 1)}…` : `${prefix}${rest}`;
}

/** Hosts longer than this show only their end. */
export const HOST_TEXT_MAX = 40;

/**
 * @param host - An ASCII host (with port).
 * @returns The host, or for a long one its end with the start elided
 *   (`…cuencada.evil.example`), cut at a label boundary when possible, so the
 *   registrable domain is never hidden.
 */
export function displayHost(host: string): string {
  if (host.length <= HOST_TEXT_MAX) return host;
  const labels = host.split(".");
  let kept = labels[labels.length - 1] ?? host;
  for (let index = labels.length - 2; index >= 0; index -= 1) {
    const next = `${labels[index] ?? ""}.${kept}`;
    if (next.length > HOST_TEXT_MAX - 1) break;
    kept = next;
  }
  // A single label (or last two) longer than the budget: keep its end anyway.
  if (kept.length > HOST_TEXT_MAX - 1) kept = host.slice(-(HOST_TEXT_MAX - 1));
  return `…${kept}`;
}

/**
 * @param body - A message body (plain text).
 * @returns Its segments in order. Text segments are verbatim; link text is rebuilt from the URL.
 */
export function linkify(body: string): TextSegment[] {
  const segments: TextSegment[] = [];
  let cursor = 0;
  for (const match of body.matchAll(URL_CANDIDATE)) {
    const start = match.index;
    const typed = trimTrailing(match[0]);
    const url = parseSafe(typed);
    if (url === null) continue;
    if (start > cursor) segments.push({ kind: "text", text: body.slice(cursor, start) });
    segments.push({ kind: "link", text: linkText(url, typed), href: url.href, title: url.href });
    cursor = start + typed.length;
  }
  if (cursor < body.length) segments.push({ kind: "text", text: body.slice(cursor) });
  return segments;
}
