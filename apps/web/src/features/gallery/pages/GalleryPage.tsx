import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Navigate, useNavigate, useParams } from "react-router-dom";
import { useAppSelector } from "../../../app/hooks";
import { isAbortError } from "../../../shared/api/errors";
import { Button } from "../../../shared/ui/Button";
import { EmptyState } from "../../../shared/ui/EmptyState";
import { Select } from "../../../shared/ui/Select";
import { Skeleton } from "../../../shared/ui/Skeleton";
import { cx } from "../../../shared/ui/cx";
import { selectIsAdmin } from "../../auth/authSlice";
import { useGalleryYearsQuery, useListMediaInfiniteQuery } from "../api";
import { GalleryLightbox } from "../components/GalleryLightbox";
import { isViewable, MediaGrid, MediaGridSkeleton } from "../components/MediaGrid";
import { UploadPanel } from "../components/UploadPanel";
import { Uploader, type UploaderHandle } from "../components/Uploader";
import styles from "../gallery.module.css";
import { parseYearParam } from "../lib/mediaText";
import { UPLOAD_RULES_TEXT } from "../lib/validateFile";
import { useExpiredUrlRefetch } from "../lib/useExpiredUrlRefetch";
import { useUploadManager } from "../upload/useUploadManager";

/** While any listed item is processing, the list is polled this often. */
export const PROCESSING_POLL_MS = 5000;

/**
 * `/galeria/:year?` (members only). Without a year, redirects to the newest
 * edition that has media.
 */
export function GalleryPage(): React.ReactNode {
  const { year: param } = useParams();
  if (param === undefined) return <DefaultYearRedirect />;
  const year = parseYearParam(param);
  if (year === null) {
    return (
      <div className={cx("cu-container", styles.page)}>
        <EmptyState icon="🔎" title="Ese año no existe" description="Revisa la dirección o elige otro año." action={<Button to="/galeria">Ver el álbum</Button>} />
      </div>
    );
  }
  return <GalleryYear key={year} year={year} />;
}

function LoadError({ onRetry }: { onRetry: () => void }): React.ReactNode {
  return (
    <EmptyState
      icon="📡"
      title="No pudimos cargar el álbum"
      description="Revisa tu conexión e inténtalo de nuevo."
      action={
        <Button variant="secondary" onClick={onRetry}>
          Reintentar
        </Button>
      }
    />
  );
}

function DefaultYearRedirect(): React.ReactNode {
  const { data, isError, error, refetch } = useGalleryYearsQuery();
  if (data) {
    if (data.defaultYear === null) {
      return (
        <div className={cx("cu-container", styles.page)}>
          <EmptyState icon="📸" title="Todavía no hay álbumes" description="Cuando haya una Cuencada, aquí podrás ver y subir sus fotos." />
        </div>
      );
    }
    return <Navigate replace to={`/galeria/${data.defaultYear}`} />;
  }
  return (
    <div className={cx("cu-container", styles.page)} aria-busy={!isError}>
      {isError && !isAbortError(error) ? (
        <LoadError onRetry={() => void refetch()} />
      ) : (
        <>
          <Skeleton shape="text" width="60%" />
          <MediaGridSkeleton />
        </>
      )}
    </div>
  );
}

function YearSwitcher({ year }: { year: number }): React.ReactNode {
  const id = useId();
  const navigate = useNavigate();
  const { data } = useGalleryYearsQuery();
  const years = useMemo(() => {
    const list = data?.years ?? [];
    return list.includes(year) ? list : [year, ...list].sort((a, b) => b - a);
  }, [data, year]);
  if (years.length < 2) return null;
  return (
    <div className={styles.yearSelect}>
      <label htmlFor={id} className="visually-hidden">
        Año del álbum
      </label>
      <Select id={id} value={String(year)} options={years.map((y) => ({ value: String(y), label: String(y) }))} onChange={(e) => navigate(`/galeria/${e.target.value}`)} />
    </div>
  );
}

function GalleryYear({ year }: { year: number }): React.ReactNode {
  const isAdmin = useAppSelector(selectIsAdmin);
  const uploader = useRef<UploaderHandle>(null);
  const { manager } = useUploadManager();
  const [poll, setPoll] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);

  const { data, isLoading, isError, error, refetch, fetchNextPage, hasNextPage, isFetchingNextPage, fulfilledTimeStamp } = useListMediaInfiniteQuery(year, {
    pollingInterval: poll ? PROCESSING_POLL_MS : 0,
    skipPollingIfUnfocused: true
  });

  const items = useMemo(() => data?.pages.flatMap((page) => page.items) ?? [], [data]);
  const viewable = useMemo(() => items.filter(isViewable), [items]);
  const processing = items.some((item) => item.uploadStatus === "processing");
  const onMediaError = useExpiredUrlRefetch(refetch);

  useEffect(() => setPoll(processing), [processing]);
  useEffect(() => {
    if (data && fulfilledTimeStamp !== undefined) manager.syncFromList(year, items, fulfilledTimeStamp);
  }, [data, items, fulfilledTimeStamp, manager, year]);

  let content: React.ReactNode;
  if (isLoading) {
    content = (
      <div aria-busy="true">
        <span className="visually-hidden">Cargando fotos…</span>
        <MediaGridSkeleton />
      </div>
    );
  } else if (isError && !data) {
    content = isAbortError(error) ? null : <LoadError onRetry={() => void refetch()} />;
  } else if (items.length === 0) {
    content = (
      <EmptyState
        icon="📸"
        title="Aún no hay fotos de este año. ¡Sé el primero en subir!"
        description="Comparte un momento de esta Cuencada con toda la familia."
        action={
          <Button icon="📤" onClick={() => uploader.current?.openPicker()}>
            Subir fotos y videos
          </Button>
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
    <div className={cx("cu-container", styles.page)}>
      <header className={styles.header}>
        <h1 className={styles.title}>Álbum vivo {year}</h1>
        <div className={styles.headerTools}>
          <YearSwitcher year={year} />
          {isAdmin ? (
            <Button to="/admin/media" size="sm" variant="ghost" icon="🛡️">
              Moderar
            </Button>
          ) : null}
        </div>
      </header>
      <Uploader ref={uploader} year={year} />
      <p className={styles.hint}>{UPLOAD_RULES_TEXT}</p>
      {content}
      <UploadPanel year={year} />
      <GalleryLightbox items={viewable} openId={openId} onOpenIdChange={setOpenId} onMediaError={onMediaError} />
    </div>
  );
}
