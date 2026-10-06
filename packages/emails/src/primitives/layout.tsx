/*
 * Container, Section and Hr, vendored from react-email (MIT, see
 * ./LICENSE.react-email.md): @react-email/container 0.0.16,
 * section 0.0.17, hr 0.0.12. Same table markup, typed, plus an optional
 * `bgcolor` attribute.
 */
import type { ReactElement } from "react";
import type { BlockProps, EmailStyle } from "./types.js";

/** Spreads `bgcolor` as a raw attribute (React passes unknown lowercase attributes through). */
function bgcolorAttr(bgcolor: string | undefined): Record<string, string> {
  return bgcolor === undefined ? {} : { bgcolor };
}

/** Fixed width of the {@link Container} column for Outlook desktop, in px. */
export const CONTAINER_WIDTH_PX = 600;

/**
 * Centred column, 37.5em (600px) max by default; one row, one cell.
 *
 * Unlike upstream, the table carries `width="600"`: Outlook desktop (Word
 * rendering engine) ignores CSS `max-width` and would stretch a
 * `width="100%"` table across the whole window. Every other client applies
 * the inline `width: 100%` + `max-width` style, which wins over the
 * attribute, so the column still shrinks on phones.
 */
export function Container({
  children,
  style,
  className,
  bgcolor,
}: BlockProps): ReactElement {
  return (
    <table
      align="center"
      width={String(CONTAINER_WIDTH_PX)}
      className={className}
      {...bgcolorAttr(bgcolor)}
      border={0}
      cellPadding="0"
      cellSpacing="0"
      role="presentation"
      style={{ width: "100%", maxWidth: "37.5em", ...style }}
    >
      <tbody>
        <tr style={{ width: "100%" }}>
          <td>{children}</td>
        </tr>
      </tbody>
    </table>
  );
}

/** Full-width block: a presentation table with one row and one cell. */
export function Section({
  children,
  style,
  className,
  bgcolor,
}: BlockProps): ReactElement {
  return (
    <table
      align="center"
      width="100%"
      border={0}
      cellPadding="0"
      cellSpacing="0"
      role="presentation"
      className={className}
      {...bgcolorAttr(bgcolor)}
      style={style}
    >
      <tbody>
        <tr>
          <td>{children}</td>
        </tr>
      </tbody>
    </table>
  );
}

/** Horizontal rule with a 1px top border. */
export function Hr({ style }: { style?: EmailStyle }): ReactElement {
  return (
    <hr
      style={{
        width: "100%",
        border: "none",
        borderTop: "1px solid #eaeaea",
        ...style,
      }}
    />
  );
}
