import type { ReactNode } from "react";
import styles from "../auth.module.css";

/** Props for {@link FormAlert}. */
export interface FormAlertProps {
  /** Message to announce; `null` renders an empty (but present) live region. */
  message: string | null;
  /** `success` uses a polite status region instead of an alert. */
  tone?: "danger" | "success";
}

/**
 * Form-level message in a live region that is always mounted, so screen
 * readers announce each new message (an alert inserted together with its
 * text is not reliably announced).
 */
export function FormAlert({ message, tone = "danger" }: FormAlertProps): ReactNode {
  const toneClass = tone === "success" ? styles.alertSuccess : styles.alertDanger;
  const content = message ? (
    <p className={`${styles.alert} ${toneClass}`}>
      <span aria-hidden="true">{tone === "success" ? "✅ " : "⚠️ "}</span>
      {message}
    </p>
  ) : null;

  if (tone === "success") return <output className={styles.alertRegion}>{content}</output>;
  return (
    <div role="alert" className={styles.alertRegion}>
      {content}
    </div>
  );
}
