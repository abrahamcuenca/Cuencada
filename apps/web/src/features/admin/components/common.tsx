import type { ReactNode } from "react";
import { Button } from "../../../shared/ui/Button";
import { Dialog } from "../../../shared/ui/Dialog";
import { EmptyState } from "../../../shared/ui/EmptyState";
import { Skeleton } from "../../../shared/ui/Skeleton";
import { cx } from "../../../shared/ui/cx";
import styles from "../admin.module.css";

/** Props for {@link ConfirmDialog}. */
export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  /** What happens if the admin confirms, in plain Spanish. */
  description: ReactNode;
  confirmLabel: string;
  /** `danger` for destructive actions (default), `primary` otherwise. */
  tone?: "danger" | "primary";
  busy: boolean;
  onConfirm: () => void;
  onClose: () => void;
}

/** Confirmation: `alertdialog`, no backdrop dismiss, the action last (thumb zone). */
export function ConfirmDialog({ open, title, description, confirmLabel, tone = "danger", busy, onConfirm, onClose }: ConfirmDialogProps): ReactNode {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      description={description}
      role="alertdialog"
      closeOnBackdrop={false}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button variant={tone} loading={busy} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </>
      }
    />
  );
}

/** Props for {@link Notice}. */
export interface NoticeProps {
  /** Message to announce; `null` keeps an empty (but mounted) live region. */
  message: string | null;
  tone?: "danger" | "success" | "info";
}

/**
 * A message in a live region that is always mounted, so each new message is
 * announced. `danger` uses `role="alert"`; the others a polite status.
 */
export function Notice({ message, tone = "danger" }: NoticeProps): ReactNode {
  const toneClass = tone === "success" ? styles.alertSuccess : tone === "info" ? styles.alertInfo : styles.alertDanger;
  const icon = tone === "success" ? "✅ " : tone === "info" ? "ℹ️ " : "⚠️ ";
  const content = message ? (
    <p className={cx(styles.alert, toneClass)}>
      <span aria-hidden="true">{icon}</span>
      {message}
    </p>
  ) : null;
  if (tone === "danger") {
    return (
      <div role="alert" className={styles.alertRegion}>
        {content}
      </div>
    );
  }
  return <output className={styles.alertRegion}>{content}</output>;
}

/** Props for {@link ListFooter}. */
export interface ListFooterProps {
  isLoading: boolean;
  isError: boolean;
  isEmpty: boolean;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  emptyTitle: string;
  emptyDescription?: string;
  errorTitle: string;
  onRetry: () => void;
  onMore: () => void;
}

/** Loading, error, empty and "Cargar más" states shared by the keyset lists. */
export function ListFooter(props: ListFooterProps): ReactNode {
  if (props.isLoading) return <Skeleton shape="block" height="8rem" />;
  if (props.isError && props.isEmpty) {
    return <EmptyState icon="⚠️" title={props.errorTitle} action={<Button onClick={props.onRetry}>Reintentar</Button>} />;
  }
  if (props.isEmpty) {
    return <EmptyState icon="🔎" title={props.emptyTitle} {...(props.emptyDescription === undefined ? {} : { description: props.emptyDescription })} />;
  }
  if (!props.hasNextPage) return null;
  return (
    <Button variant="secondary" fullWidth loading={props.isFetchingNextPage} onClick={props.onMore}>
      Cargar más
    </Button>
  );
}
