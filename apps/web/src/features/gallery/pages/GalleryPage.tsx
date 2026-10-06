import { useId, useMemo, useRef, useState } from "react";
import { Navigate, useNavigate, useParams } from "react-router-dom";
import { useAppSelector } from "../../../app/hooks";
import { isAbortError } from "../../../shared/api/errors";
import { Button } from "../../../shared/ui/Button";
import { EmptyState } from "../../../shared/ui/EmptyState";
import { Select } from "../../../shared/ui/Select";
import { Skeleton } from "../../../shared/ui/Skeleton";
import { cx } from "../../../shared/ui/cx";
import { type AccessDenial, useAccessDenial } from "../../auth/accessDenied";
import { selectIsAdmin } from "../../auth/authSlice";
import { AccessDeniedState } from "../../auth/components/AccessDeniedState";
import { MEDIA_PAGE_SIZE, useGalleryYearsQuery, useListMediaInfiniteQuery, useMediaHeadQuery } from "../api";
import { GalleryLightbox } from "../components/GalleryLightbox";
import { isViewable, MediaGrid, MediaGridSkeleton } from "../components/MediaGrid";
import { UploadPanel } from "../components/UploadPanel";
import { Uploader, type UploaderHandle } from "../components/Uploader";
import styles from "../gallery.module.css";
import { parseYearParam } from "../lib/mediaText";
import { UPLOAD_RULES_TEXT } from "../lib/validateFile";
import { useExpiredUrlRefetch } from "../lib/useExpiredUrlRefetch";
import { PROCESSING_POLL_MS } from "../upload/uploadManager";
import { useUploadManager } from "../upload/useUploadManager";


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

/** The member-only album refused with 403: unverified email, or no access at all. */
function AccessDenied({ denial }: { denial: AccessDenial }): React.ReactNode {
  return (
    <AccessDeniedState
      denial={denial}
      verifyTitle="Verifica tu correo para ver el álbum"
      forbiddenTitle="No tienes acceso al álbum"
      verifyDescription="El álbum es solo para la familia. Abre el enlace que te enviamos por correo; si no lo encuentras, pide otro."
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
  const { uploads } = useUploadManager();
  const [openId, setOpenId] = useState<string | null>(null);

  const { data, isLoading, isError, error, refetch, fetchNextPage, hasNextPage, isFetchingNextPage } = useListMediaInfiniteQuery(year);

  const items = useMemo(() => data?.pages.flatMap((page) => page.items) ?? [], [data]);
  const viewable = useMemo(() => items.filter(isViewable), [items]);
  const onMediaError = useExpiredUrlRefetch(refetch);
  const denial = useAccessDenial(error);

  // The upload manager polls for its own uploads; the page polls only for processing items it
  // doesn't track (e.g. from an earlier visit). Only the first page is fetched and patched in.
  const managerPolls = uploads.some((upload) => upload.year === year && upload.phase === "processing");
  const processing = !managerPolls && items.some((item) => item.uploadStatus === "processing");
  useMediaHeadQuery(
    { year, limit: MEDIA_PAGE_SIZE },
    { skip: !processing, pollingInterval: processing ? PROCESSING_POLL_MS : 0, skipPollingIfUnfocused: true }
  );

  let content: React.ReactNode;
  if (isLoading) {
    content = (
      <div aria-busy="true">
        <span className="visually-hidden">Cargando fotos…</span>
        <MediaGridSkeleton />
      </div>
    );
  } else if (isError && !data) {
    content = isAbortError(error) ? null : denial !== null ? <AccessDenied denial={denial} /> : <LoadError onRetry={() => void refetch()} />;
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
