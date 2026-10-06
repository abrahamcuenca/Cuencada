import type { ReactNode } from "react";
import { safeHttpsUrl } from "../lib/format";

const URL_PATTERN = /(https:\/\/[^\s<>"']+)/g;
const TRAILING_PUNCTUATION = /[.,;:!?)\]]+$/;

/**
 * Plain text with its `https://` links made clickable (announcement bodies
 * carry links such as "Ver letra oficial"). Everything else stays text, so no
 * HTML from the API is ever interpreted. Links open in a new tab.
 */
export function LinkifiedText({ text }: { text: string }): ReactNode {
  const parts = text.split(URL_PATTERN);
  return parts.map((part, index) => {
    // `split` with a capture group puts the matches at odd indexes.
    if (index % 2 === 0) return part;
    const trailing = TRAILING_PUNCTUATION.exec(part)?.[0] ?? "";
    const candidate = trailing ? part.slice(0, -trailing.length) : part;
    const href = safeHttpsUrl(candidate);
    if (href === null) return part;
    return (
      // biome-ignore lint/suspicious/noArrayIndexKey: parts are positional and never reordered.
      <span key={index}>
        <a href={href} target="_blank" rel="noopener noreferrer">
          {candidate}
        </a>
        {trailing}
      </span>
    );
  });
}
