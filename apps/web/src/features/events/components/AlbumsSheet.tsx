/**
 * Album management (WP-5.4, organizers and admins): create, rename and
 * delete albums. An album with photos cannot be deleted (409
 * `EVENT_ALBUM_NOT_EMPTY`, explained in Spanish).
 */
import { EVENT_ALBUM_TITLE_MAX_LENGTH, EVENT_ALBUMS_MAX, type EventAlbum, type EventDetail, eventAlbumTitleSchema } from "@cuencada/types";
import { type FormEvent, type ReactNode, useState } from "react";
import { isAbortError } from "../../../shared/api/errors";
import { Button } from "../../../shared/ui/Button";
import { Dialog } from "../../../shared/ui/Dialog";
import { Field } from "../../../shared/ui/Field";
import { TextInput } from "../../../shared/ui/TextInput";
import { useToast } from "../../../shared/ui/Toast";
import { useCreateAlbumMutation, useDeleteAlbumMutation, useUpdateAlbumMutation } from "../api";
import styles from "../events.module.css";
import { eventErrorMessage } from "../lib/format";

/** Props for {@link AlbumsSheet}. */
export interface AlbumsSheetProps {
  event: EventDetail;
  open: boolean;
  onClose: () => void;
}

function photoCount(count: number): string {
  return count === 1 ? "1 foto o video" : `${count} fotos y videos`;
}

/** The albums sheet. */
export function AlbumsSheet({ event, open, onClose }: AlbumsSheetProps): ReactNode {
  return (
    <Dialog open={open} onClose={onClose} title="Álbumes" description="Organiza las fotos del evento en álbumes." className={styles.sheet}>
      {open ? (
        <>
          <ul className={styles.manageList}>
            {event.albums.map((album) => (
              <AlbumRow key={album.id} eventId={event.id} album={album} />
            ))}
          </ul>
          {event.albums.length < EVENT_ALBUMS_MAX ? <NewAlbumForm eventId={event.id} /> : <p className={styles.muted}>Ya hay {EVENT_ALBUMS_MAX} álbumes, el máximo.</p>}
        </>
      ) : null}
    </Dialog>
  );
}

function NewAlbumForm({ eventId }: { eventId: string }): ReactNode {
  const toast = useToast();
  const [title, setTitle] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [create, { isLoading }] = useCreateAlbumMutation();

  const submit = (formEvent: FormEvent<HTMLFormElement>): void => {
    formEvent.preventDefault();
    const parsed = eventAlbumTitleSchema.safeParse(title);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Escribe un nombre.");
      return;
    }
    create({ id: eventId, body: { title: parsed.data } })
      .unwrap()
      .then((album) => {
        setTitle("");
        setError(null);
        toast.show({ message: `Creaste el álbum «${album.title}».`, tone: "success" });
      })
      .catch((cause: unknown) => {
        if (!isAbortError(cause)) setError(eventErrorMessage(cause));
      });
  };

  return (
    <form className={styles.sheetSection} noValidate aria-label="Nuevo álbum" onSubmit={submit}>
      <Field label="Nuevo álbum" error={error}>
        {(p) => <TextInput {...p} autoComplete="off" maxLength={EVENT_ALBUM_TITLE_MAX_LENGTH} value={title} onChange={(e) => setTitle(e.target.value)} />}
      </Field>
      <Button type="submit" variant="secondary" icon="＋" loading={isLoading}>
        Crear álbum
      </Button>
    </form>
  );
}

function AlbumRow({ eventId, album }: { eventId: string; album: EventAlbum }): ReactNode {
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(album.title);
  const [error, setError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [update, updateState] = useUpdateAlbumMutation();
  const [remove, removeState] = useDeleteAlbumMutation();

  const save = (formEvent: FormEvent<HTMLFormElement>): void => {
    formEvent.preventDefault();
    const parsed = eventAlbumTitleSchema.safeParse(title);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Escribe un nombre.");
      return;
    }
    update({ id: eventId, albumId: album.id, body: { title: parsed.data } })
      .unwrap()
      .then(() => {
        setEditing(false);
        setError(null);
        toast.show({ message: "Álbum renombrado.", tone: "success" });
      })
      .catch((cause: unknown) => {
        if (!isAbortError(cause)) setError(eventErrorMessage(cause));
      });
  };

  const onDelete = (): void => {
    remove({ id: eventId, albumId: album.id })
      .unwrap()
      .then(() => {
        setConfirmingDelete(false);
        toast.show({ message: `Eliminaste el álbum «${album.title}».`, tone: "success" });
      })
      .catch((cause: unknown) => {
        setConfirmingDelete(false);
        if (!isAbortError(cause)) toast.show({ message: eventErrorMessage(cause), tone: "danger" });
      });
  };

  return (
    <li className={styles.manageRow}>
      {editing ? (
        <form noValidate aria-label={`Renombrar ${album.title}`} className={styles.renameForm} onSubmit={save}>
          <Field label="Nombre del álbum" error={error}>
            {(p) => <TextInput {...p} autoComplete="off" maxLength={EVENT_ALBUM_TITLE_MAX_LENGTH} value={title} onChange={(e) => setTitle(e.target.value)} />}
          </Field>
          <div className={styles.inlineActions}>
            <Button type="submit" size="sm" loading={updateState.isLoading}>
              Guardar
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setEditing(false);
                setTitle(album.title);
                setError(null);
              }}
            >
              Cancelar
            </Button>
          </div>
        </form>
      ) : (
        <>
          <div className={styles.manageWho}>
            <span aria-hidden="true">🖼️</span>
            <span className={styles.personName}>
              {album.title} <span className={styles.muted}>· {photoCount(album.mediaCount)}</span>
            </span>
          </div>
          <div className={styles.inlineActions}>
            <Button variant="secondary" size="sm" onClick={() => setEditing(true)} aria-label={`Renombrar ${album.title}`}>
              Renombrar
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setConfirmingDelete(true)} aria-label={`Eliminar ${album.title}`}>
              Eliminar
            </Button>
          </div>
        </>
      )}
      <Dialog
        open={confirmingDelete}
        onClose={() => setConfirmingDelete(false)}
        role="alertdialog"
        closeOnBackdrop={false}
        title={`¿Eliminar «${album.title}»?`}
        description={album.mediaCount > 0 ? "Este álbum tiene fotos: primero hay que borrarlas." : "El álbum está vacío. No se puede deshacer."}
        footer={
          <>
            <Button variant="danger" fullWidth loading={removeState.isLoading} onClick={onDelete}>
              Eliminar álbum
            </Button>
            <Button variant="secondary" fullWidth onClick={() => setConfirmingDelete(false)}>
              Cancelar
            </Button>
          </>
        }
      />
    </li>
  );
}
