import type { AdminMediaItem, MediaModerationAction, ModerationStatus } from "@cuencada/types";
import { useMemo, useState } from "react";
import { getApiErrorMessage, isAbortError } from "../../../shared/api/errors";
import { Badge } from "../../../shared/ui/Badge";
import { Button } from "../../../shared/ui/Button";
import { Card } from "../../../shared/ui/Card";
import { Dialog } from "../../../shared/ui/Dialog";
import { EmptyState } from "../../../shared/ui/EmptyState";
import { Skeleton } from "../../../shared/ui/Skeleton";
import { Tabs } from "../../../shared/ui/Tabs";
import { useToast } from "../../../shared/ui/Toast";
import { cx } from "../../../shared/ui/cx";
import { type AdminMediaFilter, useListAdminMediaInfiniteQuery, useMediaReportsQuery, useModerateMediaMutation } from "../api";
import { REPORT_REASON_LABELS } from "../components/ItemDialogs";
import styles from "../gallery.module.css";
import { formatBytes } from "../lib/validateFile";
import { formatUploadDate, mediaAlt, uploadedByLine } from "../lib/mediaText";
import { useExpiredUrlRefetch } from "../lib/useExpiredUrlRefetch";

type QueueId = "pending" | "reported" | "hidden";

const QUEUE_IDS: readonly QueueId[] = ["pending", "reported", "hidden"];

const QUEUES: Record<QueueId, { label: string; filter: AdminMediaFilter; empty: string }> = {
  pending: { label: "Por revisar", filter: { moderationStatus: "pending_review" }, empty: "No hay fotos esperando revisión." },
  reported: { label: "Reportadas", filter: { reported: "true" }, empty: "No hay fotos reportadas." },
  hidden: { label: "Ocultas", filter: { moderationStatus: "hidden" }, empty: "No hay fotos ocultas." }
};

const STATUS_LABEL: Record<ModerationStatus, string> = {
  pending_review: "Por revisar",
  approved: "Aprobada",
  hidden: "Oculta"
};

const ACTION_DONE: Record<MediaModerationAction, string> = {
  approve: "Aprobada. Ya se ve en el álbum.",
  hide: "Oculta. Ya no se ve en el álbum.",
  delete: "Eliminada."
};

/** `/admin/media`: moderation queue (admins only; the server enforces it). */
export function AdminMediaPage(): React.ReactNode {
  const [queue, setQueue] = useState<QueueId>("pending");
  return (
    <div className={cx("cu-container", styles.page)}>
      <header className={styles.header}>
        <h1 className={styles.title}>Moderación de fotos</h1>
      </header>
      <Tabs
        label="Filtrar fotos"
        value={queue}
        onChange={(id) => {
          const next = QUEUE_IDS.find((q) => q === id);
          if (next) setQueue(next);
        }}
        items={QUEUE_IDS.map((id) => ({
          id,
          label: QUEUES[id].label,
          content: <ModerationQueue queue={id} />
        }))}
      />
    </div>
  );
}

function ModerationQueue({ queue }: { queue: QueueId }): React.ReactNode {
  const { filter, empty } = QUEUES[queue];
  const { data, isLoading, isError, error, refetch, hasNextPage, fetchNextPage, isFetchingNextPage } = useListAdminMediaInfiniteQuery(filter);
  const items = useMemo(() => data?.pages.flatMap((page) => page.items) ?? [], [data]);
  const onMediaError = useExpiredUrlRefetch(refetch);

  if (isLoading) {
    return (
      <div aria-busy="true" className={styles.queue}>
        <span className="visually-hidden">Cargando…</span>
        <Skeleton shape="block" height={180} />
        <Skeleton shape="block" height={180} />
      </div>
    );
  }
  if (isError && !data) {
    if (isAbortError(error)) return null;
    return (
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
  }
  if (items.length === 0) return <EmptyState icon="✅" title="Todo en orden" description={empty} />;

  return (
    <>
      <ul className={styles.queue}>
        {items.map((item) => (
          <ModerationCard key={item.id} item={item} onMediaError={onMediaError} />
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

function ModerationCard({ item, onMediaError }: { item: AdminMediaItem; onMediaError: () => void }): React.ReactNode {
  const [moderate, { isLoading, originalArgs }] = useModerateMediaMutation();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [showReports, setShowReports] = useState(false);
  const toast = useToast();
  const pendingAction = isLoading ? originalArgs?.body.action : undefined;

  const run = async (action: MediaModerationAction): Promise<void> => {
    try {
      await moderate({ id: item.id, body: { action } }).unwrap();
      toast.show({ message: ACTION_DONE[action], tone: "success" });
      setConfirmDelete(false);
    } catch (failure) {
      if (isAbortError(failure)) return;
      toast.show({ message: getApiErrorMessage(failure), tone: "danger" });
    }
  };

  return (
    <Card as="li" className={styles.adminCard}>
      <div className={styles.adminMedia}>
        <div className={styles.adminThumb}>
          {item.thumbUrl ? (
            <img src={item.thumbUrl} alt={mediaAlt(item)} width={96} height={96} loading="lazy" decoding="async" className={styles.thumb} onError={onMediaError} />
          ) : (
            <span role="img" aria-label={mediaAlt(item)} className={styles.videoPlaceholder}>
              {item.kind === "video" ? "▶" : "🖼️"}
            </span>
          )}
        </div>
        <div className={styles.uploadInfo}>
          <p className={styles.fileName}>{item.caption ?? item.fileName}</p>
          <p className={styles.fileMeta}>
            {uploadedByLine(item)} · {item.year} · {formatBytes(item.byteSize)}
          </p>
          <div className={styles.badges}>
            <Badge tone={item.moderationStatus === "approved" ? "success" : item.moderationStatus === "hidden" ? "danger" : "accent"}>
              {STATUS_LABEL[item.moderationStatus]}
            </Badge>
            {item.reportCount > 0 ? (
              <Badge tone="festive">
                ⚑ {item.reportCount} {item.reportCount === 1 ? "reporte" : "reportes"}
              </Badge>
            ) : null}
            {item.kind === "video" ? <Badge>🎬 Video</Badge> : null}
          </div>
          {item.moderatedByName && item.moderatedAt ? (
            <p className={styles.fileMeta}>
              Revisada por {item.moderatedByName} · {formatUploadDate(item.moderatedAt)}
            </p>
          ) : null}
        </div>
      </div>

      {item.reportCount > 0 ? (
        <div>
          <Button size="sm" variant="ghost" aria-expanded={showReports} onClick={() => setShowReports((v) => !v)}>
            {showReports ? "Ocultar reportes" : "Ver reportes"}
          </Button>
          {showReports ? <ReportList mediaId={item.id} /> : null}
        </div>
      ) : null}

      <div className={styles.adminActions}>
        {item.moderationStatus !== "approved" ? (
          <Button size="sm" loading={pendingAction === "approve"} disabled={isLoading} onClick={() => void run("approve")}>
            Aprobar
          </Button>
        ) : null}
        {item.moderationStatus !== "hidden" ? (
          <Button size="sm" variant="secondary" loading={pendingAction === "hide"} disabled={isLoading} onClick={() => void run("hide")}>
            Ocultar
          </Button>
        ) : null}
        <Button size="sm" variant="danger" disabled={isLoading} onClick={() => setConfirmDelete(true)}>
          Eliminar
        </Button>
      </div>

      <Dialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        role="alertdialog"
        closeOnBackdrop={false}
        title="¿Eliminar definitivamente?"
        description="Se quitará del álbum para toda la familia."
        footer={
          <>
            <Button variant="ghost" fullWidth onClick={() => setConfirmDelete(false)}>
              Cancelar
            </Button>
            <Button variant="danger" fullWidth loading={pendingAction === "delete"} onClick={() => void run("delete")}>
              Eliminar
            </Button>
          </>
        }
      />
    </Card>
  );
}

function ReportList({ mediaId }: { mediaId: string }): React.ReactNode {
  const { data, isLoading, isError } = useMediaReportsQuery(mediaId);
  if (isLoading) return <Skeleton lines={2} />;
  if (isError || !data) return <p className={styles.errorText}>No pudimos cargar los reportes.</p>;
  if (data.length === 0) return <p className={styles.fileMeta}>Sin reportes abiertos.</p>;
  return (
    <ul className={styles.reportList}>
      {data.map((report) => (
        <li key={report.id}>
          <p className={styles.fileName}>{REPORT_REASON_LABELS[report.reason]}</p>
          {report.details ? <p className={styles.fileMeta}>“{report.details}”</p> : null}
          <p className={styles.fileMeta}>
            {report.reporterName ?? "Un familiar"} · {formatUploadDate(report.createdAt)}
          </p>
        </li>
      ))}
    </ul>
  );
}
