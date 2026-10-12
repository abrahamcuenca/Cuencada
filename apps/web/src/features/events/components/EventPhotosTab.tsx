/**
 * The event's "Fotos" tab (WP-5.4): an album picker, then the gallery's own
 * grid, lightbox, uploader and upload panel scoped to
 * `/api/events/:id/albums/:albumId/…`. The uploader keeps the gallery's
 * gates: no bucket origin → no upload button, and the presigned URL must be
 * on the bucket origin [SEC].
 */
import type { EventAlbum, EventDetail } from "@cuencada/types";
import { type ReactNode, useId, useMemo, useRef, useState } from "react";
import { isAbortError } from "../../../shared/api/errors";
import { Button } from "../../../shared/ui/Button";
import { EmptyState } from "../../../shared/ui/EmptyState";
import { Select } from "../../../shared/ui/Select";
import { MEDIA_PAGE_SIZE, useAlbumMediaHeadQuery, useListAlbumMediaInfiniteQuery } from "../../gallery/api";
import { GalleryLightbox } from "../../gallery/components/GalleryLightbox";
import { isViewable, MediaGrid, MediaGridSkeleton } from "../../gallery/components/MediaGrid";
import { UploadPanel } from "../../gallery/components/UploadPanel";
import { Uploader, type UploaderHandle } from "../../gallery/components/Uploader";
import { type AlbumMediaScope, mediaScopeKey } from "../../gallery/lib/mediaScope";
import { LARGE_PHOTO_NOTE } from "../../gallery/lib/resizeImage";
import { uploadsConfigured } from "../../gallery/lib/uploadOrigin";
import { useExpiredUrlRefetch } from "../../gallery/lib/useExpiredUrlRefetch";
import { usePhotoParam } from "../../gallery/lib/usePhotoParam";
import { UPLOAD_LOCATION_NOTE, UPLOAD_RULES_TEXT } from "../../gallery/lib/validateFile";
import { PROCESSING_POLL_MS } from "../../gallery/upload/uploadManager";
import { useUploadManager } from "../../gallery/upload/useUploadManager";
import styles from "../events.module.css";
import { eventErrorMessage } from "../lib/format";
import { ChatUnavailable } from "./EventChatTab";

/** Props for {@link EventPhotosTab}. */
export interface EventPhotosTabProps {
  event: EventDetail;
  onJoin: () => void;
  joining: boolean;
}

/** Album picker + the album's gallery, or a join prompt for non-participants. */
export function EventPhotosTab({ event, onJoin, joining }: EventPhotosTabProps): ReactNode {
  const [albumId, setAlbumId] = useState<string | null>(null);
  const pickerId = useId();
  if (!event.hasChat) {
    if (event.canJoin) {
      return (
        <EmptyState
          icon="📸"
          title="Apúntate para ver las fotos"
          description="Las fotos del evento son para quienes participan."
          action={
            <Button loading={joining} onClick={onJoin}>
              Me apunto
            </Button>
          }
        />
      );
    }
    return <ChatUnavailable event={event} onJoin={onJoin} joining={joining} />;
  }
  const album = event.albums.find((entry) => entry.id === albumId) ?? event.albums[0];
  if (album === undefined) return <EmptyState icon="🖼️" title="Aún no hay álbumes" description="Quien organiza el evento puede crear uno." />;
  return (
    <div className={styles.photos}>
      {event.albums.length > 1 ? (
        <div className={styles.albumPicker}>
          <label htmlFor={pickerId} className={styles.albumLabel}>
            Álbum
          </label>
          <Select
            id={pickerId}
            value={album.id}
            options={event.albums.map((entry) => ({ value: entry.id, label: `${entry.title} (${entry.mediaCount})` }))}
            onChange={(e) => setAlbumId(e.target.value)}
          />
        </div>
      ) : (
        <h2 className={styles.blockTitle}>{album.title}</h2>
      )}
      <AlbumGallery key={album.id} event={event} album={album} />
    </div>
  );
}

function AlbumGallery({ event, album }: { event: EventDetail; album: EventAlbum }): ReactNode {
  const uploader = useRef<UploaderHandle>(null);
  // WP-6.2: `?foto=<id>` opens a photo (a deep link to another album's photo loads on its own).
  const [openId, setOpenId] = usePhotoParam();
  const { uploads } = useUploadManager();
  const args = { eventId: event.id, albumId: album.id };
  const scope = useMemo<AlbumMediaScope>(
    () => ({ kind: "album", eventId: event.id, albumId: album.id, label: `${album.title} · ${event.title}` }),
    [event.id, event.title, album.id, album.title]
  );
  const { data, isLoading, isError, error, refetch, fetchNextPage, hasNextPage, isFetchingNextPage } = useListAlbumMediaInfiniteQuery(args);
  const items = useMemo(() => data?.pages.flatMap((page) => page.items) ?? [], [data]);
  const viewable = useMemo(() => items.filter(isViewable), [items]);
  const onMediaError = useExpiredUrlRefetch(refetch);

  // Same split as the gallery: the upload manager polls its own uploads; the tab polls the rest.
  const managerPolls = uploads.some((upload) => upload.scopeKey === mediaScopeKey(scope) && upload.phase === "processing");
  const processing = !managerPolls && items.some((item) => item.uploadStatus === "processing");
  useAlbumMediaHeadQuery({ ...args, limit: MEDIA_PAGE_SIZE }, { skip: !processing, pollingInterval: processing ? PROCESSING_POLL_MS : 0, skipPollingIfUnfocused: true });

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
        title="No pudimos cargar el álbum"
        description={eventErrorMessage(error)}
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
        title="Aún no hay fotos en este álbum"
        description="Comparte los mejores momentos del evento."
        action={
          uploadsConfigured() ? (
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
      <Uploader ref={uploader} scope={scope} />
      <p className={styles.muted}>
        {UPLOAD_RULES_TEXT} {LARGE_PHOTO_NOTE} {UPLOAD_LOCATION_NOTE}
      </p>
      {content}
      <UploadPanel year={scope} />
      <GalleryLightbox items={viewable} openId={openId} onOpenIdChange={setOpenId} onMediaError={onMediaError} />
    </>
  );
}
