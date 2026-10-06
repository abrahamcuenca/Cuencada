import {
  Body,
  Button,
  Container,
  Head,
  Heading,
  Hr,
  Html,
  Img,
  Preview,
  Section,
  Text,
} from "@react-email/components";
import type { CSSProperties, ReactElement } from "react";
import { type EmailContent, FOOTER_BRAND, FOOTER_IGNORE } from "../content.js";

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
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";

const styles = {
  body: {
    backgroundColor: color.cream,
    margin: 0,
    padding: "24px 0",
    fontFamily: fontStack,
    color: color.ink,
  },
  container: {
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
  ctaSection: { padding: "8px 0 16px", textAlign: "center" },
  button: {
    backgroundColor: color.gold,
    color: color.ink,
    borderRadius: "12px",
    fontSize: "17px",
    fontWeight: 700,
    lineHeight: "24px",
    padding: "14px 28px",
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
} satisfies Record<string, CSSProperties>;

/** Props of {@link EmailLayout}. */
export interface EmailLayoutProps {
  content: EmailContent;
  /** Validated absolute logo URL, or `null` for the text wordmark. */
  logoUrl: string | null;
}

/**
 * Shared single-column (≤ 600px) layout: green header, white card, one gold
 * bulletproof button (48px tall), small print, optional warning and footer.
 * Contains no tracking pixels and no images other than the optional logo.
 */
export function EmailLayout({
  content,
  logoUrl,
}: EmailLayoutProps): ReactElement {
  return (
    <Html lang="es" dir="ltr">
      <Head>
        <meta name="color-scheme" content="light" />
        <meta name="supported-color-schemes" content="light" />
      </Head>
      <Preview>{content.preview}</Preview>
      <Body style={styles.body}>
        <Container style={styles.container}>
          <Section style={styles.header}>
            {logoUrl === null ? (
              <Text style={styles.wordmark}>CUENCADA</Text>
            ) : (
              <Img
                src={logoUrl}
                alt="CUENCADA"
                width="160"
                style={styles.logo}
              />
            )}
          </Section>
          <Section style={styles.stripe}>&nbsp;</Section>
          <Section style={styles.card}>
            <Heading as="h1" style={styles.heading}>
              {content.heading}
            </Heading>
            <Text style={styles.text}>{content.greeting}</Text>
            {content.paragraphs.map((paragraph) => (
              <Text key={paragraph} style={styles.text}>
                {paragraph}
              </Text>
            ))}
            {content.cta === null ? null : (
              <Section style={styles.ctaSection}>
                <Button href={content.cta.url} style={styles.button}>
                  {content.cta.label}
                </Button>
              </Section>
            )}
            {content.notes.map((note) => (
              <Text key={note} style={styles.note}>
                {note}
              </Text>
            ))}
            {content.warning === null ? null : (
              <Text style={styles.warning}>{content.warning}</Text>
            )}
            <Hr style={styles.hr} />
            <Text style={styles.footerBrand}>{FOOTER_BRAND}</Text>
            <Text style={styles.footer}>{FOOTER_IGNORE}</Text>
          </Section>
        </Container>
      </Body>
    </Html>
  );
}
