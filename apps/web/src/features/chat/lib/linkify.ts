/**
 * Splits chat text into plain-text and link segments [SEC].
 *
 * Only `http://` and `https://` URLs become links, and only after `new URL`
 * accepts them; everything else (including `javascript:`, `data:` and
 * `www.` without a scheme) stays text. The caller renders segments as React
 * text and `<a>` elements, never as HTML.
 */

/** A piece of a message body. */
export type TextSegment = { kind: "text"; text: string } | { kind: "link"; text: string; href: string };

/** Candidate URLs: a scheme, then anything up to whitespace or characters that cannot end a URL in prose. */
const URL_CANDIDATE = /\bhttps?:\/\/[^\s<>"'`]+/gi;
/** Punctuation that usually ends a sentence rather than the URL. */
const TRAILING = /[.,;:!?¡¿)\]}»”’]+$/u;

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

/**
 * @param candidate - Text that looks like a URL.
 * @returns The normalised `href` when it is a valid http(s) URL without credentials, else `null`.
 */
export function safeHref(candidate: string): string | null {
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  // `https://user:pass@host` is a classic phishing disguise.
  if (url.username !== "" || url.password !== "") return null;
  return url.href;
}

/**
 * @param body - A message body (plain text).
 * @returns Its segments in order; concatenating every `text` gives back `body`.
 */
export function linkify(body: string): TextSegment[] {
  const segments: TextSegment[] = [];
  let cursor = 0;
  for (const match of body.matchAll(URL_CANDIDATE)) {
    const start = match.index;
    const text = trimTrailing(match[0]);
    const href = safeHref(text);
    if (href === null) continue;
    if (start > cursor) segments.push({ kind: "text", text: body.slice(cursor, start) });
    segments.push({ kind: "link", text, href });
    cursor = start + text.length;
  }
  if (cursor < body.length) segments.push({ kind: "text", text: body.slice(cursor) });
  return segments;
}
