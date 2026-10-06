import type { ReactElement } from "react";
import {
  CTA_FALLBACK_LABEL,
  type EmailContent,
  FOOTER_BRAND,
} from "../content.js";
import {
  Body,
  Button,
  Container,
  type EmailStyle,
  Head,
  Heading,
  Hr,
  Html,
  Img,
  Preview,
  Section,
  Text,
} from "../primitives/index.js";

/** Brand colours from `apps/web/src/shared/styles/tokens.css` (emails cannot use CSS variables). */
const color = {
  green: "#0b5e55",
  goldOnDark: "#ffe39a",
  gold: "#e7b84b",
  cream: "#fffaf0",
  ink: "#17332f",
  muted: "#60736f",
  border: "#e2ebe6",
  danger: "#b3261e",
  dangerSoft: "#fdecea",
  white: "#ffffff",
} as const;

const fontStack =
  "-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif";

/**
 * Dark-mode hardening. The email is designed light-only:
 * - `color-scheme: light only` tells Apple Mail / iOS not to recolour it.
 * - Outlook.com marks the nodes it recolours with `data-ogsc` (text) and
 *   `data-ogsb` (background); these rules restore the brand colours there.
 * - Gmail ignores all of this and may invert; every node therefore sets an
 *   explicit text colour on an explicit background (no colour on transparent),
 *   and the button is light text on a dark, saturated background with a gold
 *   border, which inverters leave readable (see `styles.button`).
 * Static CSS only: no user input ever reaches this string.
 */
const darkModeCss = [
  ":root { color-scheme: light only; supported-color-schemes: light only; }",
  `[data-ogsc] .cu-ink { color: ${color.ink} !important; }`,
  `[data-ogsc] .cu-muted { color: ${color.muted} !important; }`,
  `[data-ogsc] .cu-brand { color: ${color.green} !important; }`,
  `[data-ogsc] .cu-wordmark { color: ${color.goldOnDark} !important; }`,
  `[data-ogsc] .cu-btn { color: ${color.white} !important; }`,
  `[data-ogsb] .cu-btn { background-color: ${color.green} !important; }`,
  `[data-ogsb] .cu-card { background-color: ${color.white} !important; }`,
  `[data-ogsb] .cu-header { background-color: ${color.green} !important; }`,
  `[data-ogsb] .cu-bg { background-color: ${color.cream} !important; }`,
  `[data-ogsb] .cu-warning { background-color: ${color.dangerSoft} !important; }`,
].join("\n");

const styles = {
  body: {
    backgroundColor: color.cream,
    margin: 0,
    padding: "24px 0",
    fontFamily: fontStack,
    color: color.ink,
  },
  container: {
    backgroundColor: color.cream,
    maxWidth: "600px",
    width: "100%",
    margin: "0 auto",
    padding: "0 12px",
  },
  header: {
    backgroundColor: color.green,
    borderRadius: "16px 16px 0 0",
    padding: "20px 24px",
    textAlign: "center",
  },
  wordmark: {
    color: color.goldOnDark,
    fontSize: "20px",
    fontWeight: 800,
    letterSpacing: "0.18em",
    lineHeight: "28px",
    margin: 0,
  },
  logo: {
    display: "block",
    margin: "0 auto",
    maxWidth: "160px",
    height: "auto",
    border: 0,
  },
  stripe: {
    backgroundColor: color.gold,
    height: "4px",
    lineHeight: "4px",
    fontSize: "4px",
  },
  card: {
    backgroundColor: color.white,
    border: `1px solid ${color.border}`,
    borderTop: 0,
    borderRadius: "0 0 16px 16px",
    padding: "28px 24px",
  },
  heading: {
    color: color.ink,
    fontSize: "24px",
    lineHeight: "32px",
    fontWeight: 800,
    margin: "0 0 16px",
  },
  text: {
    color: color.ink,
    fontSize: "16px",
    lineHeight: "26px",
    margin: "0 0 16px",
  },
  ctaSection: {
    backgroundColor: color.white,
    padding: "8px 0 16px",
    textAlign: "center",
  },
  // 2px border + 12px padding + 24px line height = 52px tall (≥ 44px target).
  // Email exception to the web "gold primary" rule: dark-mode inverters
  // (Gmail, Chromium auto-dark) lighten dark text but keep saturated
  // backgrounds, so ink-on-gold became light-on-gold (unreadable). White on
  // green (7.65:1) survives both light mode and inversion; the gold border
  // keeps the brand accent.
  button: {
    backgroundColor: color.green,
    border: `2px solid ${color.gold}`,
    color: color.white,
    borderRadius: "12px",
    fontSize: "17px",
    fontWeight: 700,
    lineHeight: "24px",
    padding: "12px 28px",
    textDecoration: "none",
    display: "inline-block",
    minWidth: "200px",
    textAlign: "center",
  },
  note: {
    color: color.muted,
    fontSize: "14px",
    lineHeight: "22px",
    margin: "0 0 8px",
  },
  fallbackLabel: {
    color: color.muted,
    fontSize: "13px",
    lineHeight: "20px",
    margin: "0 0 4px",
  },
  fallbackUrl: {
    color: color.green,
    fontSize: "13px",
    lineHeight: "20px",
    margin: "0 0 16px",
    wordBreak: "break-all",
    overflowWrap: "anywhere",
  },
  warning: {
    backgroundColor: color.dangerSoft,
    borderLeft: `4px solid ${color.danger}`,
    borderRadius: "8px",
    color: color.ink,
    fontSize: "15px",
    fontWeight: 600,
    lineHeight: "24px",
    margin: "8px 0 0",
    padding: "12px 16px",
  },
  hr: { borderColor: color.border, margin: "24px 0 16px" },
  footer: {
    color: color.muted,
    fontSize: "13px",
    lineHeight: "20px",
    margin: "0",
    textAlign: "center",
  },
  footerBrand: {
    color: color.green,
    fontSize: "12px",
    fontWeight: 700,
    letterSpacing: "0.12em",
    lineHeight: "20px",
    margin: "0",
    textAlign: "center",
  },
} satisfies Record<string, EmailStyle>;

/** Props of {@link EmailLayout}. */
export interface EmailLayoutProps {
  content: EmailContent;
  /** Validated absolute logo URL, or `null` for the text wordmark. */
  logoUrl: string | null;
}

/**
 * Shared single-column (≤ 600px) layout: green header, white card, one gold
 * bulletproof button (52px tall) with a copy-paste fallback link, small
 * print, optional warning and footer. Light-only and hardened against
 * dark-mode recolouring. Contains no tracking pixels and no images other
 * than the optional logo.
 */
export function EmailLayout({
  content,
  logoUrl,
}: EmailLayoutProps): ReactElement {
  return (
    <Html lang="es" dir="ltr">
      <Head>
        <meta name="color-scheme" content="light only" />
        <meta name="supported-color-schemes" content="light only" />
        <style>{darkModeCss}</style>
      </Head>
      <Preview>{content.preview}</Preview>
      <Body style={styles.body} className="cu-bg">
        <Container
          style={styles.container}
          className="cu-bg"
          bgcolor={color.cream}
        >
          <Section
            style={styles.header}
            className="cu-header"
            bgcolor={color.green}
          >
            {logoUrl === null ? (
              <Text style={styles.wordmark} className="cu-wordmark">
                CUENCADA
              </Text>
            ) : (
              <Img
                src={logoUrl}
                alt="CUENCADA"
                width="160"
                style={styles.logo}
              />
            )}
          </Section>
          <Section style={styles.stripe} bgcolor={color.gold}>
            &nbsp;
          </Section>
          <Section
            style={styles.card}
            className="cu-card"
            bgcolor={color.white}
          >
            <Heading as="h1" style={styles.heading} className="cu-ink">
              {content.heading}
            </Heading>
            <Text style={styles.text} className="cu-ink">
              {content.greeting}
            </Text>
            {content.paragraphs.map((block) => (
              <Text key={block.id} style={styles.text} className="cu-ink">
                {block.text}
              </Text>
            ))}
            {content.cta === null ? null : (
              <>
                <Section
                  style={styles.ctaSection}
                  className="cu-card"
                  bgcolor={color.white}
                >
                  <Button
                    href={content.cta.url}
                    style={styles.button}
                    className="cu-btn"
                  >
                    {content.cta.label}
                  </Button>
                </Section>
                <Text style={styles.fallbackLabel} className="cu-muted">
                  {CTA_FALLBACK_LABEL}
                </Text>
                <Text style={styles.fallbackUrl} className="cu-brand">
                  {content.cta.url}
                </Text>
              </>
            )}
            {content.notes.map((block) => (
              <Text key={block.id} style={styles.note} className="cu-muted">
                {block.text}
              </Text>
            ))}
            {content.warning === null ? null : (
              <Text style={styles.warning} className="cu-ink cu-warning">
                {content.warning}
              </Text>
            )}
            <Hr style={styles.hr} />
            <Text style={styles.footerBrand} className="cu-brand">
              {FOOTER_BRAND}
            </Text>
            <Text style={styles.footer} className="cu-muted">
              {content.footerNote}
            </Text>
          </Section>
        </Container>
      </Body>
    </Html>
  );
}
