/*
 * Email primitives, vendored and simplified from react-email
 * (https://github.com/resend/react-email, MIT License, Copyright (c) 2024
 * Plus Five Five, Inc). Source versions: @react-email/html 0.0.12,
 * head 0.0.13, body 0.3.0, preview 0.0.14, container 0.0.16, section 0.0.17,
 * hr 0.0.12, text 0.1.6, heading 0.0.16, img 0.0.12, button 0.2.1.
 * Those packages are deprecated upstream; only @react-email/render is kept.
 * The full MIT notice is in ./LICENSE.react-email.md.
 */
import type { CSSProperties, ReactNode } from "react";

/**
 * Inline style accepted by the primitives: React CSS plus the Outlook-only
 * `mso-*` properties React serializes from camelCase (`msoPaddingAlt` →
 * `mso-padding-alt`).
 */
export type EmailStyle = CSSProperties & {
  msoPaddingAlt?: string;
  msoTextRaise?: string;
};

/** Props shared by the table-based block primitives. */
export interface BlockProps {
  children?: ReactNode;
  style?: EmailStyle;
  className?: string;
  /** Legacy `bgcolor` attribute (Outlook desktop, dark-mode inverters). */
  bgcolor?: string;
}
