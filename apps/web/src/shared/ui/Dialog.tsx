import { type ReactNode, useId, useRef } from "react";
import styles from "./Dialog.module.css";
import { IconButton } from "./IconButton";
import { cx } from "./cx";
import { useModalDialog } from "./useModalDialog";

/** Props for {@link Dialog}. */
export interface DialogProps {
  /** Controlled open state. */
  open: boolean;
  /** Called on Esc, backdrop tap or the close button. */
  onClose: () => void;
  /** Heading, used as the accessible name (`aria-labelledby`). */
  title: ReactNode;
  /** Optional supporting text, used as `aria-describedby`. */
  description?: ReactNode;
  children?: ReactNode;
  /** Action row, pinned to the bottom of the sheet (thumb zone). Put the primary action last. */
  footer?: ReactNode;
  /** Accessible label of the close button. Defaults to "Cerrar". */
  closeLabel?: string;
  /** Allow closing by tapping the backdrop. Disable for destructive confirmations. Default true. */
  closeOnBackdrop?: boolean;
  /** `alertdialog` for confirmations that interrupt the user. */
  role?: "dialog" | "alertdialog";
  className?: string | undefined;
}

/**
 * Modal built on native `<dialog>` (top layer, inert background).
 * Renders as a bottom sheet on phones and a centred card at ≥600px.
 * Traps focus, closes on Esc/backdrop, restores focus to the opener.
 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  closeLabel = "Cerrar",
  closeOnBackdrop = true,
  role = "dialog",
  className
}: DialogProps): React.ReactNode {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const bindings = useModalDialog(ref, open, onClose, closeOnBackdrop);

  return (
    <dialog
      ref={ref}
      role={role === "alertdialog" ? "alertdialog" : undefined}
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      className={cx(styles.dialog, className)}
      tabIndex={-1}
      {...bindings}
    >
      {open ? (
        <div className={styles.panel}>
          <span aria-hidden="true" className={styles.grabber} />
          <header className={styles.header}>
            <h2 id={titleId} className={styles.title}>
              {title}
            </h2>
            <IconButton label={closeLabel} icon="✕" variant="soft" onClick={onClose} />
          </header>
          {description ? (
            <p id={descriptionId} className={styles.description}>
              {description}
            </p>
          ) : null}
          {children ? <div className={styles.body}>{children}</div> : null}
          {footer ? <footer className={styles.footer}>{footer}</footer> : null}
        </div>
      ) : null}
    </dialog>
  );
}
