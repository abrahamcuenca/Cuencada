/*
 * Text, Heading, Img and Button, vendored from react-email (MIT, see
 * ./LICENSE.react-email.md): @react-email/text 0.1.6, heading 0.0.16,
 * img 0.0.12, button 0.2.1.
 *
 * Button deliberately differs from upstream. react-email injects Outlook
 * conditional comments as raw, unescaped HTML, which this package
 * forbids (enforced by a test). Instead it uses the classic table-cell
 * bulletproof button: the cell carries `bgcolor` plus `mso-padding-alt` (what
 * Outlook desktop renders), and the anchor carries the padding, border and
 * background that every other client renders, so the whole area is clickable.
 */
import type { ReactElement, ReactNode } from "react";
import type { EmailStyle } from "./types.js";

type Margins = Pick<
  EmailStyle,
  "marginTop" | "marginRight" | "marginBottom" | "marginLeft"
>;

/** Expands a `margin` shorthand into longhands (Outlook ignores some shorthands). */
function expandMargin(style: EmailStyle | undefined): Margins {
  const result: Margins = {
    marginTop: style?.marginTop ?? "16px",
    marginBottom: style?.marginBottom ?? "16px",
  };
  if (style?.margin !== undefined) {
    const parts = String(style.margin).trim().split(/\s+/);
    const [top, right = top, bottom = top, left = right] = parts;
    Object.assign(result, {
      marginTop: top,
      marginRight: right,
      marginBottom: bottom,
      marginLeft: left,
    });
  }
  return result;
}

/** Paragraph with react-email's defaults (14px/24px, 16px vertical margins). */
export function Text({
  children,
  style,
  className,
}: {
  children: ReactNode;
  style?: EmailStyle;
  className?: string;
}): ReactElement {
  return (
    <p
      className={className}
      style={{
        fontSize: "14px",
        lineHeight: "24px",
        ...style,
        ...expandMargin(style),
      }}
    >
      {children}
    </p>
  );
}

/** Heading element (`h1`–`h6`). */
export function Heading({
  as: Tag = "h1",
  children,
  style,
  className,
}: {
  as?: "h1" | "h2" | "h3" | "h4" | "h5" | "h6";
  children: ReactNode;
  style?: EmailStyle;
  className?: string;
}): ReactElement {
  return (
    <Tag className={className} style={style}>
      {children}
    </Tag>
  );
}

/** Block image with no border or outline. */
export function Img({
  src,
  alt,
  width,
  style,
}: {
  src: string;
  alt: string;
  width?: string;
  style?: EmailStyle;
}): ReactElement {
  return (
    <img
      alt={alt}
      src={src}
      width={width}
      style={{
        display: "block",
        outline: "none",
        border: "none",
        textDecoration: "none",
        ...style,
      }}
    />
  );
}

/**
 * Bulletproof button. `style` must set `backgroundColor` and `padding`; they
 * are mirrored onto the table cell for Outlook desktop.
 */
export function Button({
  href,
  children,
  style,
  className,
}: {
  href: string;
  children: ReactNode;
  style: EmailStyle & { backgroundColor: string; padding: string };
  className?: string;
}): ReactElement {
  // Typed as EmailStyle first: React's CSSProperties has no `mso-*` keys.
  const cellStyle: EmailStyle = {
    backgroundColor: style.backgroundColor,
    borderRadius: style.borderRadius,
    msoPaddingAlt: style.padding,
  };
  const linkStyle: EmailStyle = {
    textDecoration: "none",
    display: "inline-block",
    maxWidth: "100%",
    ...style,
    msoPaddingAlt: "0px",
  };
  const cellAttrs: Record<string, string> = { bgcolor: style.backgroundColor };
  return (
    <table
      align="center"
      border={0}
      cellPadding="0"
      cellSpacing="0"
      role="presentation"
      style={{ margin: "0 auto" }}
    >
      <tbody>
        <tr>
          <td align="center" {...cellAttrs} style={cellStyle}>
            <a
              href={href}
              target="_blank"
              className={className}
              style={linkStyle}
              rel="noreferrer"
            >
              {children}
            </a>
          </td>
        </tr>
      </tbody>
    </table>
  );
}
