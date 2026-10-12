/**
 * `/recuerdos/:id` (members, WP-6.3): one box. The title, description and
 * count, then the gallery's own grid, lightbox, uploader and upload panel,
 * unchanged, scoped to `/api/memories/:id/…` through the gallery's
 * `memory` scope. The lightbox's social features (hearts, tags, comments,
 * `?foto=`) come from the gallery (WP-6.2) with no change here.
 *
 * [SEC] A draft or hidden box answers 404 like a missing one, and the page
 * shows the same "No encontramos ese baúl" for both. The uploader keeps the
 * gallery's gates: no bucket origin → no upload button, and the presigned
 * URL must be on the bucket origin.
 */
import type { MemoryAlbumDetail } from "@cuencada/types";
import { type ReactNode, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { isAbortError } from "../../../shared/api/errors";
import { Button } from "../../../shared/ui/Button";
import { EmptyState } from "../../../shared/ui/EmptyState";
import { Skeleton } from "../../../shared/ui/Skeleton";
import { cx } from "../../../shared/ui/cx";
import { useAccessDenial } from "../../auth/accessDenied";
import { AccessDeniedState } from "../../auth/components/AccessDeniedState";
import { MEDIA_PAGE_SIZE, useListMemoryMediaInfiniteQuery, useMemoryMediaHeadQuery } from "../../gallery/api";
import { GalleryLightbox } from "../../gallery/components/GalleryLightbox";
import { isViewable, MediaGrid, MediaGridSkeleton } from "../../gallery/components/MediaGrid";
import { UploadPanel } from "../../gallery/components/UploadPanel";
import { Uploader, type UploaderHandle } from "../../gallery/components/Uploader";
import { type MemoryMediaScope, mediaScopeKey } from "../../gallery/lib/mediaScope";
import { LARGE_PHOTO_NOTE } from "../../gallery/lib/resizeImage";
import { uploadsConfigured } from "../../gallery/lib/uploadOrigin";
import { useExpiredUrlRefetch } from "../../gallery/lib/useExpiredUrlRefetch";
import { UPLOAD_LOCATION_NOTE, UPLOAD_RULES_TEXT } from "../../gallery/lib/validateFile";
import { PROCESSING_POLL_MS } from "../../gallery/upload/uploadManager";
import { useUploadManager } from "../../gallery/upload/useUploadManager";
import { useMemoryAlbumQuery } from "../api";
import { isNotFound, MEMORY_BOX_NAME, MEMORY_NOT_FOUND_TITLE, mediaCountLabel, memoryErrorMessage } from "../lib/format";
import styles from "../memories.module.css";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The box page. */
export function MemoryAlbumPage(): ReactNode {
  const { id = "" } = useParams();
  const valid = UUID.test(id);
  return (
    <div className={cx("cu-container", styles.page)}>
      <Link to="/recuerdos" className={styles.back}>
        ‹ {MEMORY_BOX_NAME}
      </Link>
      {valid ? <MemoryAlbumContent id={id.toLowerCase()} /> : <NotFound />}
    </div>
  );
}

function NotFound(): ReactNode {
  return (
    <EmptyState
      icon="🗃️"
      title={MEMORY_NOT_FOUND_TITLE}
      description="Puede que ya no esté disponible."
      action={
        <Button to="/recuerdos" variant="secondary">
          Ver el baúl de recuerdos
        </Button>
      }
    />
  );
}

function MemoryAlbumContent({ id }: { id: string }): ReactNode {
  const { data, isLoading, isError, error, refetch } = useMemoryAlbumQuery(id);
  const denial = useAccessDenial(error);
  if (isLoading) {
    return (
      <div aria-busy="true" className={styles.headerSkeleton}>
        <span className="visually-hidden">Cargando baúl…</span>
        <Skeleton shape="block" width="60%" height="2rem" />
        <MediaGridSkeleton count={6} />
      </div>
    );
  }
  if (isError && data === undefined) {
    if (isAbortError(error)) return null;
    if (isNotFound(error)) return <NotFound />;
    if (denial !== null) {
      return <AccessDeniedState denial={denial} verifyTitle="Verifica tu correo para ver el baúl de recuerdos" forbiddenTitle="No tienes acceso al baúl de recuerdos" />;
    }
    return (
      <EmptyState
        icon="📡"
        title="No pudimos cargar el baúl"
        description={memoryErrorMessage(error)}
        action={
          <Button variant="secondary" onClick={() => void refetch()}>
            Reintentar
          </Button>
        }
      />
    );
  }
  if (data === undefined) return null;
  return (
    <>
      <header className={styles.boxHeader}>
        <h1 className={styles.title}>{data.title}</h1>
        <p className={styles.muted}>{mediaCountLabel(data.mediaCount)}</p>
        {data.description !== null ? <p className={styles.description}>{data.description}</p> : null}
      </header>
      <BoxGallery box={data} />
    </>
  );
}

/** The gallery's grid, lightbox and uploader on the box's scope (same split as the event album tab). */
function BoxGallery({ box }: { box: MemoryAlbumDetail }): ReactNode {
  const uploader = useRef<UploaderHandle>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const { uploads } = useUploadManager();
  const scope = useMemo<MemoryMediaScope>(() => ({ kind: "memory", memoryAlbumId: box.id, label: box.title }), [box.id, box.title]);
  const { data, isLoading, isError, error, refetch, fetchNextPage, hasNextPage, isFetchingNextPage } = useListMemoryMediaInfiniteQuery(box.id);
  const items = useMemo(() => data?.pages.flatMap((page) => page.items) ?? [], [data]);
  const viewable = useMemo(() => items.filter(isViewable), [items]);
  const onMediaError = useExpiredUrlRefetch(refetch);
  const canUpload = box.canUpload && uploadsConfigured();

  // The upload manager polls its own uploads; the page polls the rest (e.g. another tab's).
  const managerPolls = uploads.some((upload) => upload.scopeKey === mediaScopeKey(scope) && upload.phase === "processing");
  const processing = !managerPolls && items.some((item) => item.uploadStatus === "processing");
  useMemoryMediaHeadQuery(
    { memoryAlbumId: box.id, limit: MEDIA_PAGE_SIZE },
    { skip: !processing, pollingInterval: processing ? PROCESSING_POLL_MS : 0, skipPollingIfUnfocused: true }
  );

  let content: ReactNode;
  if (isLoading) {
    content = (
      <div aria-busy="true">
        <span className="visually-hidden">Cargando fotos…</span>
        <MediaGridSkeleton count={6} />
      </div>
    );
  } else if (isError && !data) {
    content = isAbortError(error) ? null : (
      <EmptyState
        icon="📡"
        title="No pudimos cargar las fotos"
        description={memoryErrorMessage(error)}
        action={
          <Button variant="secondary" onClick={() => void refetch()}>
            Reintentar
          </Button>
        }
      />
    );
  } else if (items.length === 0) {
    content = (
      <EmptyState
        icon="📸"
        title="Aún no hay fotos en este baúl"
        description="¿Tienes fotos de esa época? Súbelas para que toda la familia las vea."
        action={
          canUpload ? (
            <Button icon="📤" onClick={() => uploader.current?.openPicker()}>
              Subir fotos y videos
            </Button>
          ) : undefined
        }
      />
    );
  } else {
    content = (
      <MediaGrid
        items={items}
        onOpen={setOpenId}
        onMediaError={onMediaError}
        hasMore={hasNextPage}
        loadingMore={isFetchingNextPage}
        onLoadMore={() => {
          if (!isFetchingNextPage) void fetchNextPage();
        }}
      />
    );
  }

  return (
    <>
      {box.canUpload ? (
        <>
          <Uploader ref={uploader} scope={scope} />
          <p className={styles.muted}>
            {UPLOAD_RULES_TEXT} {LARGE_PHOTO_NOTE} {UPLOAD_LOCATION_NOTE}
          </p>
        </>
      ) : null}
      {content}
      <UploadPanel year={scope} />
      <GalleryLightbox items={viewable} openId={openId} onOpenIdChange={setOpenId} onMediaError={onMediaError} />
    </>
  );
}
