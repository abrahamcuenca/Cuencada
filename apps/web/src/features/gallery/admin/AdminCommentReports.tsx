/**
 * "Comentarios reportados" (WP-6.2): the admin queue of reported photo
 * comments, newest report first. Admins read the body of live comments, open
 * the photo (the shared lightbox, loaded by id) and delete the comment
 * (audited on the server; the body is scrubbed and a tombstone stays).
 */
import type { AdminReportedComment } from "@cuencada/types";
import { type ReactNode, useId, useMemo, useState } from "react";
import { getApiErrorMessage, isAbortError } from "../../../shared/api/errors";
import { Badge } from "../../../shared/ui/Badge";
import { Button } from "../../../shared/ui/Button";
import { Card } from "../../../shared/ui/Card";
import { Switch } from "../../../shared/ui/Checkbox";
import { Dialog } from "../../../shared/ui/Dialog";
import { EmptyState } from "../../../shared/ui/EmptyState";
import { Skeleton } from "../../../shared/ui/Skeleton";
import { useToast } from "../../../shared/ui/Toast";
import { GalleryLightbox } from "../components/GalleryLightbox";
import { REPORT_REASON_LABELS } from "../components/ItemDialogs";
import styles from "../gallery.module.css";
import { formatUploadDate } from "../lib/mediaText";
import { useAdminCommentReportsInfiniteQuery, useAdminDeleteMediaCommentMutation } from "../social/api";

const NO_ITEMS: never[] = [];

/** The reported-comments queue. */
export function AdminCommentReports(): ReactNode {
  const switchId = useId();
  const [includeDeleted, setIncludeDeleted] = useState(false);
  const [photoId, setPhotoId] = useState<string | null>(null);
  const { data, isLoading, isError, error, refetch, hasNextPage, fetchNextPage, isFetchingNextPage } = useAdminCommentReportsInfiniteQuery({ includeDeleted });
  const items = useMemo(() => data?.pages.flatMap((page) => page.items) ?? [], [data]);

  let content: ReactNode;
  if (isLoading) {
    content = (
      <div aria-busy="true" className={styles.queue}>
        <span className="visually-hidden">Cargando…</span>
        <Skeleton shape="block" height={140} />
      </div>
    );
  } else if (isError && !data) {
    content = isAbortError(error) ? null : (
      <EmptyState
        icon="📡"
        title="No pudimos cargar la lista"
        description={getApiErrorMessage(error)}
        action={
          <Button variant="secondary" onClick={() => void refetch()}>
            Reintentar
          </Button>
        }
      />
    );
  } else if (items.length === 0) {
    content = <EmptyState icon="✅" title="Todo en orden" description="No hay comentarios reportados." />;
  } else {
    content = (
      <>
        <ul className={styles.queue}>
          {items.map((comment) => (
            <ReportedCommentCard key={comment.id} comment={comment} onOpenPhoto={() => setPhotoId(comment.mediaId)} />
          ))}
        </ul>
        {hasNextPage ? (
          <div className={styles.more}>
            <Button variant="secondary" loading={isFetchingNextPage} onClick={() => void fetchNextPage()}>
              Cargar más
            </Button>
          </div>
        ) : null}
      </>
    );
  }

  return (
    <div>
      <Switch id={switchId} label="Mostrar también los eliminados" checked={includeDeleted} onChange={(event) => setIncludeDeleted(event.target.checked)} />
      {content}
      <GalleryLightbox items={NO_ITEMS} openId={photoId} onOpenIdChange={setPhotoId} onMediaError={() => undefined} />
    </div>
  );
}

function ReportedCommentCard({ comment, onOpenPhoto }: { comment: AdminReportedComment; onOpenPhoto: () => void }): ReactNode {
  const [confirm, setConfirm] = useState(false);
  const [remove, removeState] = useAdminDeleteMediaCommentMutation();
  const toast = useToast();
  const deleted = comment.deletedAt !== null;

  const doDelete = async (): Promise<void> => {
    try {
      await remove({ commentId: comment.id, mediaId: comment.mediaId }).unwrap();
      toast.show({ message: "Comentario eliminado.", tone: "success" });
      setConfirm(false);
    } catch (failure) {
      if (isAbortError(failure)) return;
      toast.show({ message: getApiErrorMessage(failure), tone: "danger" });
    }
  };

  return (
    <Card as="li" className={styles.adminCard}>
      <div className={styles.uploadInfo}>
        {deleted ? <p className={styles.fileMeta}>Comentario eliminado</p> : <p className={styles.fileName}>“{comment.body}”</p>}
        <p className={styles.fileMeta}>
          {comment.authorName ?? "Cuenta eliminada"} · {formatUploadDate(comment.createdAt)}
        </p>
        <div className={styles.badges}>
          <Badge tone="festive">
            ⚑ {comment.reportCount} {comment.reportCount === 1 ? "reporte" : "reportes"}
          </Badge>
          {deleted ? <Badge tone="danger">Eliminado</Badge> : null}
        </div>
      </div>
      <ul className={styles.reportList}>
        {comment.reports.map((report) => (
          <li key={report.id}>
            <p className={styles.fileName}>{REPORT_REASON_LABELS[report.reason]}</p>
            {report.details ? <p className={styles.fileMeta}>“{report.details}”</p> : null}
            <p className={styles.fileMeta}>
              {report.reporterName ?? "Un familiar"} · {formatUploadDate(report.createdAt)}
            </p>
          </li>
        ))}
      </ul>
      <div className={styles.adminActions}>
        <Button size="sm" variant="secondary" onClick={onOpenPhoto}>
          Ver foto
        </Button>
        {deleted ? null : (
          <Button size="sm" variant="danger" onClick={() => setConfirm(true)}>
            Eliminar comentario
          </Button>
        )}
      </div>
      <Dialog
        open={confirm}
        onClose={() => setConfirm(false)}
        role="alertdialog"
        closeOnBackdrop={false}
        title="¿Eliminar este comentario?"
        description="Se borrará su texto para siempre y quedará como “Comentario eliminado”."
        footer={
          <>
            <Button variant="ghost" fullWidth onClick={() => setConfirm(false)}>
              Cancelar
            </Button>
            <Button variant="danger" fullWidth loading={removeState.isLoading} onClick={() => void doDelete()}>
              Eliminar
            </Button>
          </>
        }
      />
    </Card>
  );
}
