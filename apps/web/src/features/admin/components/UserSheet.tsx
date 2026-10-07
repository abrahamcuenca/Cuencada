import type { AdminUserListItem } from "@cuencada/types";
import { type ReactNode, useState } from "react";
import { Link } from "react-router-dom";
import { isAbortError } from "../../../shared/api/errors";
import { Badge } from "../../../shared/ui/Badge";
import { Button } from "../../../shared/ui/Button";
import { Dialog } from "../../../shared/ui/Dialog";
import styles from "../admin.module.css";
import {
  useForceAdminPasswordResetMutation,
  useRevokeAdminUserSessionsMutation,
  useUpdateAdminUserMutation,
  useVerifyAdminUserEmailMutation
} from "../api";
import { formatInstant } from "../lib/format";
import { ROLE_LABEL, USER_STATUS_LABEL } from "../lib/labels";
import { userActionErrorMessage } from "../lib/userErrors";
import { ConfirmDialog, Notice } from "./common";

/** Actions that ask for confirmation first. */
type ConfirmableAction = "promote" | "demote" | "disable" | "enable" | "revoke" | "forceReset";

interface ActionCopy {
  title: string;
  description: string;
  confirmLabel: string;
  tone: "danger" | "primary";
}

/** Told when the change touches an administrator account (T8-BE emails every other active admin). */
export const ADMIN_ALERT_NOTE = " Los demás administradores recibirán un aviso por correo.";

/**
 * Spanish confirmation copy: what happens to the person if the admin goes ahead.
 * Changes to an administrator account (or a promotion) add {@link ADMIN_ALERT_NOTE}.
 */
function actionCopy(action: ConfirmableAction, user: AdminUserListItem): ActionCopy {
  const copy = baseActionCopy(action, user);
  const alertsAdmins = action === "promote" || (user.role === "admin" && action !== "revoke");
  return alertsAdmins ? { ...copy, description: copy.description + ADMIN_ALERT_NOTE } : copy;
}

function baseActionCopy(action: ConfirmableAction, user: AdminUserListItem): ActionCopy {
  const name = user.displayName;
  switch (action) {
    case "promote":
      return {
        title: `¿Hacer administrador a ${name}?`,
        description: "Podrá invitar gente, cambiar cuentas, moderar fotos y ver la bitácora.",
        confirmLabel: "Hacer administrador",
        tone: "primary"
      };
    case "demote":
      return {
        title: `¿Quitarle el rol de administrador a ${name}?`,
        description: "Seguirá siendo miembro de la familia, pero ya no podrá entrar al Panel de administración.",
        confirmLabel: "Quitar administrador",
        tone: "danger"
      };
    case "disable":
      return {
        title: `¿Deshabilitar la cuenta de ${name}?`,
        description:
          "Se cerrarán todas sus sesiones y sus enlaces de correo pendientes dejarán de funcionar. No podrá entrar hasta que habilites la cuenta otra vez.",
        confirmLabel: "Deshabilitar cuenta",
        tone: "danger"
      };
    case "enable":
      return {
        title: `¿Habilitar la cuenta de ${name}?`,
        description: "Podrá entrar otra vez. Sus sesiones anteriores siguen cerradas, así que tendrá que iniciar sesión.",
        confirmLabel: "Habilitar cuenta",
        tone: "primary"
      };
    case "revoke":
      return {
        title: `¿Cerrar las sesiones de ${name}?`,
        description: `Se cerrarán todas sus sesiones (${user.activeSessionCount} activas) en todos sus dispositivos. Tendrá que entrar de nuevo.`,
        confirmLabel: "Cerrar sesiones",
        tone: "danger"
      };
    case "forceReset":
      return {
        title: `¿Forzar el cambio de contraseña de ${name}?`,
        description:
          "Se cerrarán todas sus sesiones, sus enlaces de correo pendientes dejarán de funcionar y le enviaremos un correo para elegir una contraseña nueva.",
        confirmLabel: "Forzar cambio",
        tone: "danger"
      };
  }
}

/** Props for {@link UserSheet}. */
export interface UserSheetProps {
  user: AdminUserListItem;
  /** The signed-in admin's own account: role, status and session actions are disabled. */
  isSelf: boolean;
  onClose: () => void;
  /** Called with the server's fresh row after each change. */
  onUpdated: (user: AdminUserListItem) => void;
}

/**
 * The user detail sheet (bottom sheet on phones, card at ≥600px). Every
 * consequential action confirms first and says what will happen; the server's
 * guardrails (403 self, 409 last admin) come back as Spanish alerts.
 */
export function UserSheet({ user, isSelf, onClose, onUpdated }: UserSheetProps): ReactNode {
  const [pending, setPending] = useState<ConfirmableAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ tone: "success" | "info"; message: string } | null>(null);
  const [update, updateState] = useUpdateAdminUserMutation();
  const [revoke, revokeState] = useRevokeAdminUserSessionsMutation();
  const [forceReset, forceState] = useForceAdminPasswordResetMutation();
  const [verify, verifyState] = useVerifyAdminUserEmailMutation();
  const busy = updateState.isLoading || revokeState.isLoading || forceState.isLoading || verifyState.isLoading;

  const run = async (action: () => Promise<{ tone: "success" | "info"; message: string }>): Promise<void> => {
    setError(null);
    setResult(null);
    try {
      setResult(await action());
    } catch (caught) {
      if (isAbortError(caught)) return;
      setError(userActionErrorMessage(caught));
    } finally {
      setPending(null);
    }
  };

  const perform = (action: ConfirmableAction): Promise<void> =>
    run(async () => {
      switch (action) {
        case "promote":
        case "demote": {
          const next = await update({ id: user.id, patch: { role: action === "promote" ? "admin" : "member" } }).unwrap();
          onUpdated(next);
          return { tone: "success", message: action === "promote" ? "Ahora es administrador." : "Ya no es administrador." };
        }
        case "disable":
        case "enable": {
          const next = await update({ id: user.id, patch: { status: action === "disable" ? "disabled" : "active" } }).unwrap();
          onUpdated(next);
          return action === "disable"
            ? { tone: "success", message: "Cuenta deshabilitada. Cerramos todas sus sesiones." }
            : { tone: "success", message: "Cuenta habilitada. Ya puede entrar otra vez." };
        }
        case "revoke": {
          await revoke(user.id).unwrap();
          onUpdated({ ...user, activeSessionCount: 0 });
          return { tone: "success", message: "Cerramos todas sus sesiones." };
        }
        case "forceReset": {
          const reset = await forceReset(user.id).unwrap();
          onUpdated(reset.user);
          return reset.emailQueued
            ? { tone: "success", message: "Listo. Cerramos sus sesiones y le enviamos un correo para elegir una contraseña nueva." }
            : {
                tone: "info",
                message:
                  "Cerramos sus sesiones y tendrá que cambiar su contraseña, pero no se envió el correo (la cuenta está deshabilitada o se alcanzó el límite de correos). Avísale por otro medio."
              };
        }
      }
    });

  const markVerified = (): Promise<void> =>
    run(async () => {
      onUpdated(await verify(user.id).unwrap());
      return { tone: "success", message: "Marcamos su correo como verificado." };
    });

  const copy = pending === null ? null : actionCopy(pending, user);
  const isAdmin = user.role === "admin";
  const isActive = user.status === "active";

  return (
    <>
      <Dialog open onClose={onClose} title={user.displayName} description={user.email}>
        <div className={styles.panel}>
          <div className={styles.badges}>
            {isSelf ? <Badge tone="brand">Tú</Badge> : null}
            <Badge tone={isAdmin ? "festive" : "neutral"}>{ROLE_LABEL[user.role]}</Badge>
            <Badge tone={isActive ? "success" : "danger"}>{USER_STATUS_LABEL[user.status]}</Badge>
            {user.emailVerified ? null : <Badge tone="accent">Correo sin verificar</Badge>}
            {user.mustChangePassword ? <Badge tone="accent">Debe cambiar su contraseña</Badge> : null}
          </div>
          <dl className={styles.facts}>
            <dt>Último acceso</dt>
            <dd>{user.lastLoginAt === null ? "Nunca" : formatInstant(user.lastLoginAt)}</dd>
            <dt>Sesiones activas</dt>
            <dd>{user.activeSessionCount}</dd>
            <dt>Cuenta creada</dt>
            <dd>{formatInstant(user.createdAt)}</dd>
          </dl>

          <Notice message={error} />
          <Notice message={result?.tone === "success" ? result.message : null} tone="success" />
          <Notice message={result?.tone === "info" ? result.message : null} tone="info" />

          {isSelf ? (
            <p className={styles.selfNote}>
              Esta es tu cuenta: no puedes cambiar tu propio rol, deshabilitarte, forzar tu contraseña ni verificar tu correo desde aquí. Para
              cerrar tus sesiones o cambiar tu contraseña ve a <Link to="/perfil/sesiones">Mis sesiones</Link>.
            </p>
          ) : null}

          <div className={styles.sheetActions}>
            <Button variant="secondary" fullWidth disabled={isSelf || busy} onClick={() => setPending(isAdmin ? "demote" : "promote")}>
              {isAdmin ? "Quitar rol de administrador" : "Hacer administrador"}
            </Button>
            <Button variant="secondary" fullWidth disabled={isSelf || busy || user.activeSessionCount === 0} onClick={() => setPending("revoke")}>
              Cerrar sesiones
            </Button>
            <Button variant="secondary" fullWidth disabled={isSelf || busy} onClick={() => setPending("forceReset")}>
              Forzar cambio de contraseña
            </Button>
            {user.emailVerified ? null : (
              <Button variant="secondary" fullWidth disabled={isSelf || busy} loading={verifyState.isLoading} onClick={() => void markVerified()}>
                Marcar correo como verificado
              </Button>
            )}
            <Button variant={isActive ? "danger" : "primary"} fullWidth disabled={isSelf || busy} onClick={() => setPending(isActive ? "disable" : "enable")}>
              {isActive ? "Deshabilitar cuenta" : "Habilitar cuenta"}
            </Button>
          </div>

          <p className={styles.muted}>
            <Link to={`/admin/bitacora?actor=${encodeURIComponent(user.id)}`}>Ver su actividad en la bitácora</Link>
            {user.personId === null ? null : (
              <>
                {" · "}
                <Link to={`/admin/familia/${encodeURIComponent(user.personId)}`}>Ver en el árbol</Link>
              </>
            )}
          </p>
        </div>
      </Dialog>
      <ConfirmDialog
        open={copy !== null}
        title={copy?.title ?? ""}
        description={copy?.description ?? ""}
        confirmLabel={copy?.confirmLabel ?? ""}
        tone={copy?.tone ?? "danger"}
        busy={busy}
        onConfirm={() => {
          if (pending !== null) void perform(pending);
        }}
        onClose={() => setPending(null)}
      />
    </>
  );
}
