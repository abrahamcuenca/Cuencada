import {
  type MergeFieldChoice,
  PERSON_MERGE_FIELDS,
  type PersonDateIssue,
  type PersonMergeChoices,
  type PersonMergeField,
  type PersonMergePreview,
  type PersonMergeResponse,
  type PersonMergeSide,
  mergedPersonValues,
  personDatesIssue
} from "@cuencada/types";
import { type ReactNode, useState } from "react";
import { useNavigate } from "react-router-dom";
import { getApiErrorCode, getApiErrorMessage, isAbortError } from "../../../../shared/api/errors";
import { AvatarCircle } from "../../../../shared/ui/AvatarCircle";
import { Button } from "../../../../shared/ui/Button";
import { Dialog } from "../../../../shared/ui/Dialog";
import { Skeleton } from "../../../../shared/ui/Skeleton";
import { useToast } from "../../../../shared/ui/Toast";
import { cx } from "../../../../shared/ui/cx";
import { useGetMergePreviewQuery, useMergePeopleMutation, useRevertRevisionMutation } from "../api";
import {
  MERGE_BLOCKER_TEXT,
  MERGE_CONFLICT_REASONS,
  MERGE_FIELD_LABELS,
  describeMergeEdge,
  describeSelfEdge,
  formatMergeValue,
  sameMergeValue
} from "../lib/merge";
import { ConfirmDialog } from "./ConfirmDialog";
import styles from "./merge.module.css";

/** Text of the final confirmation ("Esta acción combina a las dos personas en una sola…"). */
export function mergeConfirmText(keepName: string, duplicateName: string): string {
  return `Esta acción combina a las dos personas en una sola: ${duplicateName} desaparece del árbol y sus datos, relaciones y cuenta pasan a ${keepName}. Podrás deshacerla desde «Actividad del árbol» mientras nadie cambie a ${keepName}.`;
}

/** Props for {@link MergeSheet}. */
export interface MergeSheetProps {
  /** The person that stays. */
  keepId: string;
  /** The person merged into it and removed. */
  duplicateId: string;
  onClose: () => void;
  /** "Cambiar cuál se queda": swap keep and duplicate. */
  onSwap: () => void;
}

/**
 * "Fusionar personas" preview (a bottom sheet on phones): both people side by
 * side, a radio choice per differing field, the relationships that move or
 * drop, conflicts with a Spanish explanation, the photo and account outcome,
 * and a final confirmation. After the merge it opens the kept person and
 * offers "Deshacer" in a toast. Mount it with a `key` per pair, so the
 * choices start from the defaults again.
 */
export function MergeSheet({ keepId, duplicateId, onClose, onSwap }: MergeSheetProps): ReactNode {
  const preview = useGetMergePreviewQuery({ keepId, duplicateId }, { refetchOnMountOrArgChange: true });
  const data = preview.currentData;
  const [overrides, setOverrides] = useState<PersonMergeChoices>({});
  const [confirming, setConfirming] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [mergePeople, mergeState] = useMergePeopleMutation();
  const [revert] = useRevertRevisionMutation();
  const navigate = useNavigate();
  const toast = useToast();

  const choices: PersonMergeChoices = data === undefined ? {} : { ...data.defaults, ...overrides };
  const datesIssue = data === undefined ? null : personDatesIssue(mergedPersonValues(data.keep.values, data.duplicate.values, choices));
  const keepName = data?.keep.person.fullName ?? "";
  const duplicateName = data?.duplicate.person.fullName ?? "";

  const undo = async (result: PersonMergeResponse): Promise<void> => {
    try {
      await revert(result.revisionId).unwrap();
      toast.show({ message: "Deshicimos la fusión.", tone: "success" });
    } catch (error) {
      if (!isAbortError(error)) toast.show({ message: getApiErrorMessage(error), tone: "danger" });
    }
  };

  const doMerge = async (): Promise<void> => {
    setServerError(null);
    try {
      const result = await mergePeople({ keepId, duplicateId, fields: choices }).unwrap();
      setConfirming(false);
      onClose();
      navigate(`/admin/familia/${encodeURIComponent(result.person.id)}`);
      toast.show({
        message: `Fusionamos a ${duplicateName} con ${keepName}.`,
        tone: "success",
        ...(result.revertible ? { action: { label: "Deshacer", onClick: () => void undo(result) } } : {})
      });
    } catch (error) {
      setConfirming(false);
      if (isAbortError(error)) return;
      setServerError(getApiErrorMessage(error));
      // The tree may have changed (409): show the current preview.
      void preview.refetch();
    }
  };

  let body: ReactNode;
  if (data !== undefined) {
    body = (
      <MergePreviewBody
        preview={data}
        choices={choices}
        datesIssue={datesIssue}
        serverError={serverError}
        onChoose={(field, choice) => setOverrides((current) => ({ ...current, [field]: choice }))}
        onSwap={onSwap}
      />
    );
  } else if (preview.isError) {
    body = (
      <p role="alert" className={styles.meta}>
        {getApiErrorCode(preview.error) === "NOT_FOUND" ? "Una de las dos personas ya no está en el árbol." : "No pudimos preparar la fusión. Inténtalo otra vez."}
      </p>
    );
  } else {
    body = <Skeleton shape="block" height="16rem" />;
  }

  return (
    <>
      <Dialog
        open={!confirming}
        onClose={onClose}
        title="Fusionar personas"
        description={data === undefined ? undefined : `${duplicateName} se combina con ${keepName}, que es quien se queda en el árbol.`}
        className={styles.sheet}
        footer={
          <>
            <Button variant="secondary" onClick={onClose}>
              Cancelar
            </Button>
            {data !== undefined ? (
              <Button variant="danger" disabled={data.blockers.length > 0 || datesIssue !== null} onClick={() => setConfirming(true)}>
                Fusionar
              </Button>
            ) : null}
          </>
        }
      >
        {body}
      </Dialog>
      <ConfirmDialog
        open={confirming}
        title={`¿Fusionar a ${duplicateName} con ${keepName}?`}
        description={mergeConfirmText(keepName, duplicateName)}
        confirmLabel="Fusionar"
        busy={mergeState.isLoading}
        onConfirm={() => void doMerge()}
        onClose={() => setConfirming(false)}
      />
    </>
  );
}

function SideCard({ side, label, keep }: { side: PersonMergeSide; label: string; keep: boolean }): ReactNode {
  const { person } = side;
  const facts = [
    side.accountName === null ? "Sin cuenta" : `Cuenta: ${side.accountName}`,
    side.relationshipCount === 1 ? "1 relación" : `${side.relationshipCount} relaciones`,
    ...(side.hasTreePhoto ? ["Con foto del árbol"] : [])
  ];
  return (
    <div className={cx(styles.side, keep && styles.sideKeep)}>
      <AvatarCircle name={person.fullName} src={person.avatarUrl ?? undefined} size="md" decorative />
      <div className={styles.sideText}>
        <span className={styles.sideRole}>{label}</span>
        <p className={styles.sideName}>{person.fullName}</p>
        <span className={styles.meta}>{facts.join(" · ")}</span>
      </div>
    </div>
  );
}

interface MergePreviewBodyProps {
  preview: PersonMergePreview;
  choices: PersonMergeChoices;
  datesIssue: PersonDateIssue | null;
  serverError: string | null;
  onChoose: (field: PersonMergeField, choice: MergeFieldChoice) => void;
  onSwap: () => void;
}

function MergePreviewBody({ preview, choices, datesIssue, serverError, onChoose, onSwap }: MergePreviewBodyProps): ReactNode {
  const { keep, duplicate } = preview;
  const keepName = keep.person.fullName;
  const duplicateName = duplicate.person.fullName;
  const differing = PERSON_MERGE_FIELDS.filter((field) => !sameMergeValue(field, keep.values, duplicate.values));
  // Equal and worth saying ("living" on both sides is not a datum).
  const same = PERSON_MERGE_FIELDS.filter(
    (field) => sameMergeValue(field, keep.values, duplicate.values) && keep.values[field] !== null && keep.values[field] !== false
  );
  const { moved, dropped, conflicts } = preview.relationships;
  const photoText =
    preview.photo.result === "keep"
      ? `Se queda la foto del árbol de ${keepName}.`
      : preview.photo.result === "duplicate"
        ? `${keepName} recibe la foto del árbol de ${duplicateName}.`
        : "Ninguna de las dos tiene foto del árbol.";
  const accountText =
    preview.account.result === "moved"
      ? `La cuenta de ${duplicate.accountName ?? duplicateName} pasa a ${keepName}.`
      : preview.account.result === "keep"
        ? `${keepName} conserva su cuenta.`
        : "Ninguna de las dos tiene cuenta.";

  return (
    <div className={styles.body}>
      <div className={styles.sides}>
        <SideCard side={keep} label="Se queda" keep />
        <SideCard side={duplicate} label="Se quita" keep={false} />
      </div>
      <Button variant="ghost" size="sm" onClick={onSwap}>
        Cambiar cuál se queda
      </Button>

      {serverError !== null ? (
        <div role="alert" className={styles.alert}>
          <p className={styles.alertTitle}>No se pudo fusionar</p>
          <span>{serverError}</span>
        </div>
      ) : null}
      {preview.blockers.map((code) => (
        <div key={code} role="alert" className={styles.alert}>
          <p className={styles.alertTitle}>No se pueden fusionar todavía</p>
          <span>{MERGE_BLOCKER_TEXT[code] ?? "Esta fusión no se puede hacer."}</span>
        </div>
      ))}

      <section aria-labelledby="merge-datos" className={styles.section}>
        <h3 id="merge-datos" className={styles.sectionTitle}>
          Datos
        </h3>
        {differing.length === 0 ? <p className={styles.meta}>Los datos de las dos personas coinciden.</p> : null}
        {differing.map((field) => (
          <fieldset key={field} className={styles.field}>
            <legend className={styles.legend}>{MERGE_FIELD_LABELS[field]}</legend>
            <div className={styles.choices}>
              {(["keep", "duplicate"] as const).map((choice) => (
                <label key={choice} className={styles.choice}>
                  <input
                    type="radio"
                    name={`merge-${field}`}
                    value={choice}
                    checked={(choices[field] ?? preview.defaults[field]) === choice}
                    onChange={() => onChoose(field, choice)}
                  />
                  <span className={styles.choiceText}>
                    <span className={styles.choiceValue}>{formatMergeValue(field, choice === "keep" ? keep.values : duplicate.values)}</span>
                    <span className={styles.choiceWho}>de {choice === "keep" ? keepName : duplicateName}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
        ))}
        {same.length > 0 ? (
          <p className={styles.meta}>Iguales en las dos: {same.map((field) => MERGE_FIELD_LABELS[field].toLowerCase()).join(", ")}.</p>
        ) : null}
        {datesIssue !== null ? (
          <p role="alert" className={styles.alert}>
            Revisa las fechas: {datesIssue.message}
          </p>
        ) : null}
      </section>

      <section aria-labelledby="merge-relaciones" className={styles.section}>
        <h3 id="merge-relaciones" className={styles.sectionTitle}>
          Relaciones
        </h3>
        {moved.length === 0 && dropped.length === 0 && conflicts.length === 0 ? (
          <p className={styles.meta}>{duplicateName} no tiene relaciones en el árbol.</p>
        ) : null}
        {moved.length > 0 ? (
          <>
            <p className={styles.meta}>Pasan a {keepName}:</p>
            <ul className={styles.list} aria-label={`Relaciones que pasan a ${keepName}`}>
              {moved.map((edge) => (
                <li key={edge.id} className={styles.listItem}>
                  {describeMergeEdge(edge)}
                </li>
              ))}
            </ul>
          </>
        ) : null}
        {dropped.length > 0 ? (
          <>
            <p className={styles.meta}>No hacen falta (ya existen o unen a las dos personas):</p>
            <ul className={styles.list} aria-label="Relaciones que se quitan">
              {dropped.map((edge) => (
                <li key={edge.id} className={styles.listItem}>
                  {edge.outcome === "self" ? describeSelfEdge(edge) : describeMergeEdge(edge)}
                </li>
              ))}
            </ul>
          </>
        ) : null}
        {conflicts.length > 0 ? (
          <>
            <p className={styles.meta}>No se pueden mover:</p>
            <ul className={styles.list} aria-label="Relaciones con conflicto">
              {conflicts.map((edge) => (
                <li key={edge.id} className={cx(styles.listItem, styles.conflict)}>
                  <strong>{describeMergeEdge(edge)}</strong>
                  <span>{MERGE_CONFLICT_REASONS[edge.reason]}</span>
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </section>

      <section aria-labelledby="merge-cuenta" className={styles.section}>
        <h3 id="merge-cuenta" className={styles.sectionTitle}>
          Cuenta y foto
        </h3>
        <ul className={styles.facts}>
          <li>{accountText}</li>
          <li>{photoText}</li>
          {preview.photo.deletesDuplicatePhoto ? <li>La foto del árbol de {duplicateName} se borra.</li> : null}
          {preview.invites.move > 0 ? <li>Sus invitaciones pasan a {keepName}.</li> : null}
          {preview.invites.revoke > 0 ? <li>Se revoca su invitación pendiente: {keepName} ya no la necesita.</li> : null}
          {preview.attendance.move + preview.attendance.drop > 0 ? <li>Sus asistencias a Cuencadas pasan a {keepName}.</li> : null}
        </ul>
      </section>
    </div>
  );
}
