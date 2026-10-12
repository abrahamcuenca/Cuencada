/**
 * `/admin/recuerdos` (admins, WP-6.3): Panel → "Baúl de recuerdos". Every
 * box in every status: create, edit (title, description, status), pick the
 * cover from the box's own photos, publish / hide, reorder (↑ / ↓, saved at
 * once) and delete (refused while the box has photos). Members add photos on
 * the box page; the photos' moderation is `/admin/media`.
 */
import type { AdminMemoryAlbum, MemoryAlbumStatus } from "@cuencada/types";
import { MEMORY_ALBUM_DESCRIPTION_MAX_LENGTH, MEMORY_ALBUM_TITLE_MAX_LENGTH } from "@cuencada/types";
import { type FormEvent, type ReactNode, useId, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { isAbortError } from "../../../shared/api/errors";
import { Badge, type BadgeTone } from "../../../shared/ui/Badge";
import { Button } from "../../../shared/ui/Button";
import { Dialog } from "../../../shared/ui/Dialog";
import { EmptyState } from "../../../shared/ui/EmptyState";
import { Field } from "../../../shared/ui/Field";
import { IconButton } from "../../../shared/ui/IconButton";
import { Select } from "../../../shared/ui/Select";
import { Skeleton } from "../../../shared/ui/Skeleton";
import { TextArea } from "../../../shared/ui/TextArea";
import { TextInput } from "../../../shared/ui/TextInput";
import { useToast } from "../../../shared/ui/Toast";
import { cx } from "../../../shared/ui/cx";
import { useListMemoryMediaInfiniteQuery } from "../../gallery/api";
import {
  useCreateMemoryAlbumMutation,
  useDeleteMemoryAlbumMutation,
  useListAdminMemoriesQuery,
  useReorderMemoryAlbumsMutation,
  useUpdateMemoryAlbumMutation
} from "../api";
import { MemoryCover } from "../components/MemoryCard";
import { MEMORY_BOX_NAME, mediaCountLabel, memoryErrorMessage, memoryPath, STATUS_LABELS } from "../lib/format";
import styles from "../memories.module.css";

const STATUS_TONES: Record<MemoryAlbumStatus, BadgeTone> = { draft: "neutral", published: "success", hidden: "danger" };

const STATUS_OPTIONS = (["draft", "published", "hidden"] as const).map((status) => ({ value: status, label: STATUS_LABELS[status] }));

function isStatus(value: string): value is MemoryAlbumStatus {
  return value === "draft" || value === "published" || value === "hidden";
}

/**
 * @param ids - Current order.
 * @param index - Row to move.
 * @param delta - `-1` up, `+1` down.
 * @returns The new order, or `null` when the move falls off either end.
 */
export function moveId(ids: readonly string[], index: number, delta: -1 | 1): string[] | null {
  const target = index + delta;
  if (index < 0 || index >= ids.length || target < 0 || target >= ids.length) return null;
  const next = [...ids];
  const [moved] = next.splice(index, 1);
  if (moved === undefined) return null;
  next.splice(target, 0, moved);
  return next;
}

/** The panel page. */
export function AdminMemoriesPage(): ReactNode {
  const { data, isLoading, isError, error, refetch } = useListAdminMemoriesQuery();
  const [creating, setCreating] = useState(false);
  const boxes = data?.items ?? [];

  let content: ReactNode;
  if (isLoading) {
    content = <Skeleton shape="block" height="12rem" />;
  } else if (isError && data === undefined) {
    content = isAbortError(error) ? null : (
      <EmptyState
        icon="📡"
        title="No pudimos cargar los baúles"
        description="Revisa tu conexión e inténtalo de nuevo."
        action={
          <Button variant="secondary" onClick={() => void refetch()}>
            Reintentar
          </Button>
        }
      />
    );
  } else if (boxes.length === 0) {
    content = (
      <EmptyState
        icon="🗃️"
        title="Aún no hay baúles"
        description="Crea uno (por ejemplo, «Fotos antiguas» o «Bodas de la familia») y publícalo para que la familia agregue sus fotos."
      />
    );
  } else {
    content = <BoxList boxes={boxes} />;
  }

  return (
    <div className={cx("cu-container", styles.page)}>
      <Link to="/admin" className={styles.back}>
        ‹ Panel
      </Link>
      <header className={styles.listHeader}>
        <div>
          <h1 className={styles.title}>{MEMORY_BOX_NAME}</h1>
          <p className={styles.intro}>Los borradores y los ocultos solo los ven los administradores. Los publicados aparecen en el orden de esta lista.</p>
        </div>
        <Button icon="＋" onClick={() => setCreating(true)}>
          Nuevo baúl
        </Button>
      </header>
      {content}
      {creating ? <BoxFormSheet onClose={() => setCreating(false)} /> : null}
    </div>
  );
}

function BoxList({ boxes }: { boxes: readonly AdminMemoryAlbum[] }): ReactNode {
  const toast = useToast();
  const [reorder, reorderState] = useReorderMemoryAlbumsMutation();
  const ids = boxes.map((box) => box.id);

  const move = (index: number, delta: -1 | 1): void => {
    const next = moveId(ids, index, delta);
    if (next === null) return;
    reorder(next)
      .unwrap()
      .catch((cause: unknown) => {
        if (!isAbortError(cause)) toast.show({ message: memoryErrorMessage(cause), tone: "danger" });
      });
  };

  return (
    <ol className={styles.adminList} aria-label="Baúles" aria-busy={reorderState.isLoading}>
      {boxes.map((box, index) => (
        <BoxRow
          key={box.id}
          box={box}
          first={index === 0}
          last={index === boxes.length - 1}
          busy={reorderState.isLoading}
          onMoveUp={() => move(index, -1)}
          onMoveDown={() => move(index, 1)}
        />
      ))}
    </ol>
  );
}

interface BoxRowProps {
  box: AdminMemoryAlbum;
  first: boolean;
  last: boolean;
  busy: boolean;
  onMoveUp: () => void;
  onMoveDown: () => void;
}

function BoxRow({ box, first, last, busy, onMoveUp, onMoveDown }: BoxRowProps): ReactNode {
  const toast = useToast();
  const [update, updateState] = useUpdateMemoryAlbumMutation();
  const [remove, removeState] = useDeleteMemoryAlbumMutation();
  const [editing, setEditing] = useState(false);
  const [confirm, setConfirm] = useState<"hide" | "delete" | null>(null);
  const published = box.status === "published";

  const fail = (cause: unknown): void => {
    setConfirm(null);
    if (!isAbortError(cause)) toast.show({ message: memoryErrorMessage(cause), tone: "danger" });
  };

  const setStatus = (status: MemoryAlbumStatus): void => {
    update({ id: box.id, body: { status } })
      .unwrap()
      .then(() => {
        setConfirm(null);
        toast.show({ message: status === "published" ? `Publicaste ${box.title}.` : `Ocultaste ${box.title}.`, tone: "success" });
      })
      .catch(fail);
  };

  const onDelete = (): void => {
    remove(box.id)
      .unwrap()
      .then(() => {
        setConfirm(null);
        toast.show({ message: `Eliminaste ${box.title}.`, tone: "success" });
      })
      .catch(fail);
  };

  return (
    <li className={styles.adminRow}>
      <MemoryCover url={box.coverUrl} className={styles.adminCover} />
      <div className={styles.adminInfo}>
        <Badge tone={STATUS_TONES[box.status]}>{STATUS_LABELS[box.status]}</Badge>
        <h2 className={styles.adminTitle}>
          <Link to={memoryPath(box.id)}>{box.title}</Link>
        </h2>
        <p className={styles.muted}>
          {mediaCountLabel(box.mediaCount)} · Creado por {box.createdByName ?? "una cuenta eliminada"}
        </p>
      </div>
      <div className={styles.adminActions}>
        <div className={styles.orderButtons}>
          <IconButton label={`Subir ${box.title}`} icon="↑" disabled={first || busy} onClick={onMoveUp} />
          <IconButton label={`Bajar ${box.title}`} icon="↓" disabled={last || busy} onClick={onMoveDown} />
        </div>
        <Button variant="secondary" size="sm" onClick={() => setEditing(true)}>
          Editar
        </Button>
        {published ? (
          <Button variant="secondary" size="sm" onClick={() => setConfirm("hide")}>
            Ocultar
          </Button>
        ) : (
          <Button variant="secondary" size="sm" loading={updateState.isLoading} onClick={() => setStatus("published")}>
            Publicar
          </Button>
        )}
        <Button variant="ghost" size="sm" onClick={() => setConfirm("delete")}>
          Eliminar
        </Button>
      </div>
      {editing ? <BoxFormSheet box={box} onClose={() => setEditing(false)} /> : null}
      <Dialog
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        role="alertdialog"
        closeOnBackdrop={false}
        title={confirm === "delete" ? `¿Eliminar ${box.title}?` : `¿Ocultar ${box.title}?`}
        description={
          confirm === "delete"
            ? box.mediaCount > 0
              ? "Este baúl todavía tiene fotos o videos: bórralos primero, o mejor ocúltalo."
              : "Se borra el baúl. No se puede deshacer."
            : "Nadie de la familia lo verá (ni sus fotos, etiquetas, corazones o comentarios) hasta que lo vuelvas a publicar."
        }
        footer={
          <>
            <Button
              variant="danger"
              fullWidth
              loading={confirm === "delete" ? removeState.isLoading : updateState.isLoading}
              onClick={confirm === "delete" ? onDelete : () => setStatus("hidden")}
            >
              {confirm === "delete" ? "Eliminar baúl" : "Ocultar baúl"}
            </Button>
            <Button variant="secondary" fullWidth onClick={() => setConfirm(null)}>
              Cancelar
            </Button>
          </>
        }
      />
    </li>
  );
}

/** Props for {@link BoxFormSheet}: `box` to edit, none to create. */
interface BoxFormSheetProps {
  box?: AdminMemoryAlbum;
  onClose: () => void;
}

/** Create or edit a box (title, description, status; the cover when editing). */
function BoxFormSheet({ box, onClose }: BoxFormSheetProps): ReactNode {
  const toast = useToast();
  const formId = useId();
  const [create, createState] = useCreateMemoryAlbumMutation();
  const [update, updateState] = useUpdateMemoryAlbumMutation();
  const [title, setTitle] = useState(box?.title ?? "");
  const [description, setDescription] = useState(box?.description ?? "");
  const [status, setStatus] = useState<MemoryAlbumStatus>(box?.status ?? "draft");
  const [coverMediaId, setCoverMediaId] = useState<string | null>(box?.coverMediaId ?? null);
  const [titleError, setTitleError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const saving = createState.isLoading || updateState.isLoading;

  const onSubmit = (event: FormEvent): void => {
    event.preventDefault();
    const cleanTitle = title.trim();
    if (cleanTitle === "") {
      setTitleError("Escribe un título.");
      return;
    }
    setTitleError(null);
    setFormError(null);
    const fields = { title: cleanTitle, description: description.trim() === "" ? null : description, status };
    const request =
      box === undefined
        ? create(fields).unwrap()
        : update({ id: box.id, body: { ...fields, ...(coverMediaId !== box.coverMediaId ? { coverMediaId } : {}) } }).unwrap();
    request
      .then(() => {
        toast.show({ message: box === undefined ? `Creaste ${cleanTitle}.` : "Cambios guardados.", tone: "success" });
        onClose();
      })
      .catch((cause: unknown) => {
        if (!isAbortError(cause)) setFormError(memoryErrorMessage(cause));
      });
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={box === undefined ? "Nuevo baúl" : `Editar ${box.title}`}
      footer={
        <>
          <Button type="submit" form={formId} fullWidth loading={saving}>
            {box === undefined ? "Crear baúl" : "Guardar"}
          </Button>
          <Button variant="secondary" fullWidth onClick={onClose}>
            Cancelar
          </Button>
        </>
      }
    >
      <form id={formId} className={styles.form} onSubmit={onSubmit} noValidate>
        <Field label="Título" required error={titleError ?? undefined}>
          {(control) => (
            <TextInput {...control} value={title} maxLength={MEMORY_ALBUM_TITLE_MAX_LENGTH} onChange={(e) => setTitle(e.target.value)} />
          )}
        </Field>
        <Field label="Descripción" showOptional hint="Qué hay en este baúl y de qué época son las fotos.">
          {(control) => (
            <TextArea
              {...control}
              value={description}
              rows={3}
              maxLength={MEMORY_ALBUM_DESCRIPTION_MAX_LENGTH}
              onChange={(e) => setDescription(e.target.value)}
            />
          )}
        </Field>
        <Field label="Estado" hint="Solo los baúles publicados son visibles para la familia.">
          {(control) => (
            <Select
              {...control}
              value={status}
              options={STATUS_OPTIONS}
              onChange={(e) => {
                if (isStatus(e.target.value)) setStatus(e.target.value);
              }}
            />
          )}
        </Field>
        {box === undefined ? null : <CoverPicker boxId={box.id} value={coverMediaId} onChange={setCoverMediaId} />}
        {formError !== null ? (
          <p role="alert" className={styles.formError}>
            {formError}
          </p>
        ) : null}
      </form>
    </Dialog>
  );
}

/** Cover choice: "Automática" (the newest photo) or one of the box's ready, approved photos (first page). */
function CoverPicker({ boxId, value, onChange }: { boxId: string; value: string | null; onChange: (id: string | null) => void }): ReactNode {
  const name = useId();
  const { data, isLoading } = useListMemoryMediaInfiniteQuery(boxId);
  const photos = useMemo(
    () =>
      (data?.pages[0]?.items ?? []).filter(
        (item) => item.kind === "image" && item.uploadStatus === "ready" && item.moderationStatus === "approved" && item.thumbUrl !== null
      ),
    [data]
  );
  return (
    <fieldset className={styles.coverPicker}>
      <legend className={styles.coverLegend}>Portada</legend>
      {isLoading ? <Skeleton shape="block" height="5rem" /> : null}
      <label className={styles.coverOption}>
        <input type="radio" name={name} checked={value === null} onChange={() => onChange(null)} />
        <span className={styles.coverAuto}>Automática (la foto más reciente)</span>
      </label>
      {!isLoading && photos.length === 0 ? <p className={styles.muted}>Cuando el baúl tenga fotos, podrás elegir una.</p> : null}
      <div className={styles.coverGrid}>
        {photos.map((photo, index) => (
          <label key={photo.id} className={styles.coverOption}>
            <input
              type="radio"
              name={name}
              checked={value === photo.id}
              onChange={() => onChange(photo.id)}
              aria-label={photo.caption !== null ? `Portada: ${photo.caption}` : `Portada: foto ${index + 1}`}
            />
            <img src={photo.thumbUrl ?? ""} alt="" width={96} height={72} loading="lazy" decoding="async" className={styles.coverThumb} />
          </label>
        ))}
      </div>
    </fieldset>
  );
}
