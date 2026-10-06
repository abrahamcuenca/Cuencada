/*
 * Html, Head, Body and Preview, vendored from react-email (MIT, see
 * ./LICENSE.react-email.md): @react-email/html 0.0.12, head 0.0.13,
 * body 0.3.0, preview 0.0.14. Same markup, typed and trimmed to what
 * Cuencada uses.
 */
import type { ReactElement, ReactNode } from "react";
import type { EmailStyle } from "./types.js";

/** Root `<html>` element. */
export function Html({
  children,
  lang,
  dir = "ltr",
}: {
  children: ReactNode;
  lang: string;
  dir?: "ltr" | "rtl";
}): ReactElement {
  return (
    <html dir={dir} lang={lang}>
      {children}
    </html>
  );
}

/** `<head>` with the charset and Apple anti-reformatting metas react-email emits. */
export function Head({ children }: { children?: ReactNode }): ReactElement {
  return (
    <head>
      <meta content="text/html; charset=UTF-8" httpEquiv="Content-Type" />
      <meta name="x-apple-disable-message-reformatting" />
      {children}
    </head>
  );
}

const SPACING_PROPS = [
  "margin",
  "marginTop",
  "marginBottom",
  "marginLeft",
  "marginRight",
  "padding",
  "paddingTop",
  "paddingBottom",
  "paddingLeft",
  "paddingRight",
] as const;

/**
 * `<body>` wrapping a full-width presentation table. The style goes on the
 * inner cell (clients such as Gmail drop `<body>` styles); the body itself
 * only keeps the background and zeroes any margin/padding that was set.
 */
export function Body({
  children,
  style,
  className,
}: {
  children: ReactNode;
  style: EmailStyle;
  className?: string;
}): ReactElement {
  const bodyStyle: EmailStyle = { backgroundColor: style.backgroundColor };
  for (const property of SPACING_PROPS) {
    if (style[property] !== undefined) {
      bodyStyle[property] = 0;
    }
  }
  return (
    <body className={className} style={bodyStyle}>
      <table
        border={0}
        width="100%"
        cellPadding="0"
        cellSpacing="0"
        role="presentation"
        align="center"
      >
        <tbody>
          <tr>
            <td style={style}>{children}</td>
          </tr>
        </tbody>
      </table>
    </body>
  );
}

const PREVIEW_MAX_LENGTH = 150;
/** NBSP, ZWNJ, ZWSP, ZWJ, LRM, RLM, BOM: pads the inbox snippet so body text doesn't leak into it. */
const PREVIEW_FILLER = "\u00a0\u200c\u200b\u200d\u200e\u200f\ufeff";

/** Hidden inbox preview text (≤ 150 chars), padded with invisible filler. */
export function Preview({ children }: { children: string }): ReactElement {
  const text = children.substring(0, PREVIEW_MAX_LENGTH);
  return (
    <div
      style={{
        display: "none",
        overflow: "hidden",
        lineHeight: "1px",
        opacity: 0,
        maxHeight: 0,
        maxWidth: 0,
      }}
      data-skip-in-text={true}
    >
      {text}
      {text.length < PREVIEW_MAX_LENGTH ? (
        <div>{PREVIEW_FILLER.repeat(PREVIEW_MAX_LENGTH - text.length)}</div>
      ) : null}
    </div>
  );
}
