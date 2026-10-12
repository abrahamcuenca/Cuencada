/**
 * "Fotos" tab of the person page (WP-6.2): photos the person is tagged in,
 * from `GET /api/family/people/:id/photos`. The server returns only photos
 * the viewer can see (approved tags, visible scopes, published editions), so
 * the list never hints at anything else. Reuses the gallery grid and lightbox.
 * Loaded lazily the first time the tab opens.
 */
import { type ReactNode, useMemo } from "react";
import { isAbortError } from "../../../shared/api/errors";
import { Button } from "../../../shared/ui/Button";
import { EmptyState } from "../../../shared/ui/EmptyState";
import { GalleryLightbox } from "../../gallery/components/GalleryLightbox";
import { isViewable, MediaGrid, MediaGridSkeleton } from "../../gallery/components/MediaGrid";
import { useExpiredUrlRefetch } from "../../gallery/lib/useExpiredUrlRefetch";
import { usePhotoParam } from "../../gallery/lib/usePhotoParam";
import { usePersonPhotosInfiniteQuery } from "../../gallery/social/api";

/** Props for {@link PersonPhotos}. */
export interface PersonPhotosProps {
  personId: string;
  personName: string;
}

/** Photo grid of one person, with the shared lightbox. */
export function PersonPhotos({ personId, personName }: PersonPhotosProps): ReactNode {
  const [openId, setOpenId] = usePhotoParam();
  const { data, isLoading, isError, error, refetch, hasNextPage, fetchNextPage, isFetchingNextPage } = usePersonPhotosInfiniteQuery(personId);
  const items = useMemo(() => data?.pages.flatMap((page) => page.items) ?? [], [data]);
  const viewable = useMemo(() => items.filter(isViewable), [items]);
  const onMediaError = useExpiredUrlRefetch(refetch);

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
        description="Revisa tu conexión e inténtalo de nuevo."
        action={
          <Button variant="secondary" onClick={() => void refetch()}>
            Reintentar
          </Button>
        }
      />
    );
  } else if (items.length === 0) {
    content = <EmptyState icon="🏷️" title={`Aún no hay fotos de ${personName}`} description="Cuando alguien la etiquete en una foto, aparecerá aquí." />;
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
      {content}
      <GalleryLightbox items={viewable} openId={openId} onOpenIdChange={setOpenId} onMediaError={onMediaError} />
    </>
  );
}
