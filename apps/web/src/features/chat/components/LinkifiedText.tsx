import { type ReactNode, useMemo } from "react";
import { linkify } from "../lib/linkify";

/** Props for {@link LinkifiedText}. */
export interface LinkifiedTextProps {
  text: string;
}

/**
 * Renders a message body as plain text, with http(s) URLs as links that open
 * in a new tab without an opener or referrer [SEC]. No HTML is ever parsed.
 */
export function LinkifiedText({ text }: LinkifiedTextProps): ReactNode {
  const segments = useMemo(() => linkify(text), [text]);
  return segments.map((segment, index) =>
    segment.kind === "link" ? (
      // biome-ignore lint/suspicious/noArrayIndexKey: segments are positional and never reordered.
      <a key={index} href={segment.href} title={segment.title} target="_blank" rel="noopener noreferrer">
        {segment.text}
      </a>
    ) : (
      // biome-ignore lint/suspicious/noArrayIndexKey: as above.
      <span key={index}>{segment.text}</span>
    )
  );
}
