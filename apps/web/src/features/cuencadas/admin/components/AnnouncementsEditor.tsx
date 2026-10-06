import { type Announcement, createAnnouncementInputSchema } from "@cuencada/types";
import { type FormEvent, type ReactNode, useState } from "react";
import { formatDate } from "../../../../shared/lib/dates";
import { Badge } from "../../../../shared/ui/Badge";
import { Button } from "../../../../shared/ui/Button";
import { Card } from "../../../../shared/ui/Card";
import { Checkbox } from "../../../../shared/ui/Checkbox";
import { EmptyState } from "../../../../shared/ui/EmptyState";
import { Skeleton } from "../../../../shared/ui/Skeleton";
import { useToast } from "../../../../shared/ui/Toast";
import { useCreateAnnouncementMutation, useDeleteAnnouncementMutation, useListAdminAnnouncementsQuery, useUpdateAnnouncementMutation } from "../api";
import { type FieldErrors, issuesToFieldErrors, serverErrorToFieldErrors } from "../forms";
import styles from "../admin.module.css";
import { ConfirmDialog, toastError } from "./common";
import { FormError, SelectField, TextField, VISIBILITY_OPTIONS } from "./fields";

/** Props for {@link AnnouncementsEditor}. */
export interface AnnouncementsEditorProps {
  /** The Cuencada's id, or `null` for portal-wide announcements (Home). */
  cuencadaId: string | null;
  timeZone: string;
}

/**
 * Announcements ("Avisos") CRUD for one Cuencada, or portal-wide when
 * `cuencadaId` is `null`. Public ones show on the public pages; members-only
 * ones only to logged-in family.
 */
export function AnnouncementsEditor({ cuencadaId, timeZone }: AnnouncementsEditorProps): ReactNode {
  const toast = useToast();
  const list = useListAdminAnnouncementsQuery(cuencadaId === null ? {} : { cuencadaId });
  const [remove, removeState] = useDeleteAnnouncementMutation();
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [toDelete, setToDelete] = useState<Announcement | null>(null);
  // Without a filter the API returns every announcement; keep only the portal-wide ones here.
  const announcements = (list.data ?? []).filter((announcement) => announcement.cuencadaId === cuencadaId);

  const confirmDelete = (): void => {
    if (toDelete === null) return;
    remove(toDelete.id)
      .unwrap()
      .then(() => {
        toast.show({ message: "Aviso eliminado.", tone: "success" });
        setToDelete(null);
      })
      .catch((error: unknown) => toastError(toast, error));
  };

  return (
    <div className={styles.editor}>
      <div className={styles.editorHeader}>
        <p className={styles.muted}>{announcements.length === 1 ? "1 aviso" : `${announcements.length} avisos`}</p>
        {editing === "new" ? null : (
          <Button icon="＋" size="sm" onClick={() => setEditing("new")}>
            Nuevo aviso
          </Button>
        )}
      </div>
      {editing === "new" ? <AnnouncementForm cuencadaId={cuencadaId} announcement={null} onDone={() => setEditing(null)} /> : null}
      {list.data === undefined ? (
        list.error === undefined ? (
          <Skeleton shape="block" height="6rem" />
        ) : (
          <p role="alert" className={styles.formError}>
            No pudimos cargar los avisos.
          </p>
        )
      ) : announcements.length === 0 && editing !== "new" ? (
        <EmptyState icon="📣" headingLevel={3} title="Sin avisos" description="Publica un aviso para la familia." />
      ) : (
        <ul className={styles.rows}>
          {announcements.map((announcement) => (
            <li key={announcement.id}>
              {editing === announcement.id ? (
                <AnnouncementForm cuencadaId={cuencadaId} announcement={announcement} onDone={() => setEditing(null)} />
              ) : (
                <Card padding="sm" className={styles.row}>
                  <div className={styles.rowMain}>
                    <p className={styles.rowMeta}>{formatDate(announcement.publishedAt, timeZone)}</p>
                    <h4 className={styles.rowTitle}>
                      {announcement.pinned ? <span aria-hidden="true">📌 </span> : null}
                      {announcement.title}
                    </h4>
                    <Badge tone={announcement.visibility === "members" ? "accent" : "brand"}>
                      {announcement.visibility === "members" ? "Solo familia" : "Público"}
                    </Badge>
                  </div>
                  <div className={styles.rowActions}>
                    <Button variant="secondary" size="sm" onClick={() => setEditing(announcement.id)}>
                      Editar
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setToDelete(announcement)}>
                      Eliminar
                    </Button>
                  </div>
                </Card>
              )}
            </li>
          ))}
        </ul>
      )}
      <ConfirmDialog
        open={toDelete !== null}
        title="¿Eliminar este aviso?"
        description={toDelete ? `«${toDelete.title}» dejará de mostrarse.` : ""}
        confirmLabel="Eliminar"
        busy={removeState.isLoading}
        onConfirm={confirmDelete}
        onClose={() => setToDelete(null)}
      />
    </div>
  );
}

interface AnnouncementFormProps {
  cuencadaId: string | null;
  announcement: Announcement | null;
  onDone: () => void;
}

function AnnouncementForm({ cuencadaId, announcement, onDone }: AnnouncementFormProps): ReactNode {
  const toast = useToast();
  const [values, setValues] = useState({
    title: announcement?.title ?? "",
    body: announcement?.body ?? "",
    visibility: announcement?.visibility ?? "members"
  });
  const [pinned, setPinned] = useState(announcement?.pinned ?? false);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [create, createState] = useCreateAnnouncementMutation();
  const [update, updateState] = useUpdateAnnouncementMutation();
  const onChange = (name: string, value: string): void => setValues((current) => ({ ...current, [name]: value }));

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const parsed = createAnnouncementInputSchema.safeParse({ ...values, pinned, cuencadaId });
    if (!parsed.success) {
      setErrors(issuesToFieldErrors(parsed.error.issues));
      return;
    }
    setErrors({});
    const { cuencadaId: _cuencadaId, ...patch } = parsed.data;
    const request = announcement ? update({ id: announcement.id, patch }) : create(parsed.data);
    request
      .unwrap()
      .then(() => {
        toast.show({ message: announcement ? "Cambios guardados." : "Aviso publicado.", tone: "success" });
        onDone();
      })
      .catch((error: unknown) => setErrors(serverErrorToFieldErrors(error, "No pudimos guardar el aviso. Inténtalo otra vez.")));
  };

  return (
    <Card padding="sm">
      <form noValidate onSubmit={submit} className={styles.form} aria-label={announcement ? `Editar «${announcement.title}»` : "Nuevo aviso"}>
        <FormError errors={errors} />
        <TextField name="title" label="Título" required maxLength={200} value={values.title} errors={errors} onChange={onChange} />
        <TextField
          name="body"
          label="Mensaje"
          required
          multiline
          maxLength={5000}
          hint="Los enlaces https:// se vuelven clicables."
          value={values.body}
          errors={errors}
          onChange={onChange}
        />
        <SelectField name="visibility" label="¿Quién lo ve?" options={VISIBILITY_OPTIONS} value={values.visibility} errors={errors} onChange={onChange} />
        <Checkbox label="Fijar arriba" hint="Los avisos fijados se muestran primero." checked={pinned} onChange={(event) => setPinned(event.target.checked)} />
        <div className={styles.formActions}>
          <Button variant="secondary" onClick={onDone}>
            Cancelar
          </Button>
          <Button type="submit" loading={createState.isLoading || updateState.isLoading}>
            {announcement ? "Guardar cambios" : "Publicar aviso"}
          </Button>
        </div>
      </form>
    </Card>
  );
}
