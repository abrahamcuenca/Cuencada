import type { SessionListItem } from "@cuencada/types";
import { type ReactNode, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAppDispatch } from "../../../app/hooks";
import { isAbortError } from "../../../shared/api/errors";
import { formatDate } from "../../../shared/lib/dates";
import { Badge } from "../../../shared/ui/Badge";
import { Button } from "../../../shared/ui/Button";
import { Card } from "../../../shared/ui/Card";
import { Dialog } from "../../../shared/ui/Dialog";
import { EmptyState } from "../../../shared/ui/EmptyState";
import { Skeleton } from "../../../shared/ui/Skeleton";
import { useToast } from "../../../shared/ui/Toast";
import { useListSessionsQuery, useRevokeOtherSessionsMutation, useRevokeSessionMutation } from "../api";
import styles from "../auth.module.css";
import { describeAuthError } from "../forms";
import { LOGIN_PATH } from "../guards";
import { logout } from "../session";
import { formatRelativeTime, PORTAL_TIME_ZONE, summarizeUserAgent } from "../sessionDisplay";

type Confirming = "others" | "everywhere" | null;

/** One session row: device, last activity, current badge, revoke. */
function SessionRow({ session, onRevoke, revoking }: { session: SessionListItem; onRevoke: (id: string) => void; revoking: boolean }): ReactNode {
  const device = summarizeUserAgent(session.userAgent);
  const lastUsed = formatRelativeTime(session.lastUsedAt);
  const lastUsedFull = formatDate(session.lastUsedAt, PORTAL_TIME_ZONE, { dateStyle: "medium", timeStyle: "short" });

  return (
    <Card as="li" className={styles.session} padding="md">
      <p className={styles.sessionHead}>
        <span aria-hidden="true">{device.icon}</span>
        <span>{device.label}</span>
        {session.current ? <Badge tone="success">Esta sesión</Badge> : null}
      </p>
      <p className={styles.sessionMeta}>
        Última actividad: <time dateTime={session.lastUsedAt} title={lastUsedFull}>{lastUsed}</time>
        {session.ipAddress ? ` · IP ${session.ipAddress}` : null}
      </p>
      <p className={styles.sessionMeta}>Abierta el {formatDate(session.createdAt, PORTAL_TIME_ZONE, { dateStyle: "medium" })}</p>
      {session.current ? null : (
        <div className={styles.sessionActions}>
          <Button variant="secondary" size="sm" loading={revoking} onClick={() => onRevoke(session.id)} aria-label={`Cerrar la sesión de ${device.label}`}>
            Cerrar
          </Button>
        </div>
      )}
    </Card>
  );
}

/**
 * `/perfil/sesiones`: the caller's own sessions. Revoke one, close every
 * other session, or log out on every device (revoke the others, then the
 * regular `logout()` for this one).
 */
export function SessionsPage(): ReactNode {
  const dispatch = useAppDispatch();
  const navigate = useNavigate();
  const toast = useToast();
  const { data: sessions, error, isLoading, isFetching, refetch } = useListSessionsQuery();
  const [revokeSession] = useRevokeSessionMutation();
  const [revokeOthers, { isLoading: revokingOthers }] = useRevokeOtherSessionsMutation();
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<Confirming>(null);
  const [loggingOut, setLoggingOut] = useState(false);

  const showError = (cause: unknown): void => {
    const message = describeAuthError(cause);
    if (message !== null) toast.show({ message, tone: "danger" });
  };

  const onRevoke = (id: string): void => {
    if (revokingId !== null) return;
    setRevokingId(id);
    revokeSession({ id })
      .unwrap()
      .then(() => toast.show({ message: "Sesión cerrada.", tone: "success" }))
      .catch(showError)
      .finally(() => setRevokingId(null));
  };

  const onRevokeOthers = (): void => {
    revokeOthers()
      .unwrap()
      .then(() => {
        setConfirming(null);
        toast.show({ message: "Cerramos las demás sesiones.", tone: "success" });
      })
      .catch((cause: unknown) => {
        setConfirming(null);
        showError(cause);
      });
  };

  const onLogoutEverywhere = (): void => {
    if (loggingOut) return;
    setLoggingOut(true);
    revokeOthers()
      .unwrap()
      .then(async () => {
        await dispatch(logout());
        void navigate(LOGIN_PATH, { replace: true });
      })
      .catch((cause: unknown) => {
        setLoggingOut(false);
        setConfirming(null);
        showError(cause);
      });
  };

  const otherCount = (sessions ?? []).filter((session) => !session.current).length;

  let content: ReactNode;
  if (isLoading) {
    content = (
      <div aria-busy="true">
        <span className="visually-hidden">Cargando sesiones…</span>
        <Skeleton shape="block" height={120} />
      </div>
    );
  } else if (error !== undefined && !isAbortError(error)) {
    content = (
      <EmptyState
        icon="⚠️"
        title="No pudimos cargar tus sesiones"
        description={describeAuthError(error) ?? undefined}
        action={
          <Button onClick={() => void refetch()} loading={isFetching}>
            Reintentar
          </Button>
        }
      />
    );
  } else {
    content = (
      <ul className={styles.sessionList} aria-label="Tus sesiones" aria-busy={isFetching || undefined}>
        {(sessions ?? []).map((session) => (
          <SessionRow key={session.id} session={session} onRevoke={onRevoke} revoking={revokingId === session.id} />
        ))}
      </ul>
    );
  }

  return (
    <div className={styles.listPage}>
      <h1 className={styles.title}>Sesiones activas</h1>
      <p className={styles.lead}>Estos son los dispositivos donde tienes la sesión abierta. Si no reconoces alguno, ciérralo y cambia tu contraseña.</p>
      {content}
      <div className={styles.actions}>
        {otherCount > 0 ? (
          <Button variant="secondary" fullWidth onClick={() => setConfirming("others")}>
            Cerrar las demás sesiones
          </Button>
        ) : null}
        <Button variant="danger" fullWidth onClick={() => setConfirming("everywhere")}>
          Cerrar sesión en todos los dispositivos
        </Button>
        <Button variant="ghost" fullWidth to="/cambiar-contrasena">
          Cambiar contraseña
        </Button>
      </div>

      <Dialog
        open={confirming === "others"}
        onClose={() => setConfirming(null)}
        role="alertdialog"
        closeOnBackdrop={false}
        title="¿Cerrar las demás sesiones?"
        description="Tendrás que volver a entrar en esos dispositivos. Esta sesión sigue abierta."
        footer={
          <>
            <Button variant="danger" fullWidth loading={revokingOthers} onClick={onRevokeOthers}>
              Cerrar las demás
            </Button>
            <Button variant="secondary" fullWidth onClick={() => setConfirming(null)}>
              Cancelar
            </Button>
          </>
        }
      />
      <Dialog
        open={confirming === "everywhere"}
        onClose={() => setConfirming(null)}
        role="alertdialog"
        closeOnBackdrop={false}
        title="¿Cerrar sesión en todos los dispositivos?"
        description="Saldrás también de este dispositivo y tendrás que volver a entrar en todos."
        footer={
          <>
            <Button variant="danger" fullWidth loading={loggingOut} onClick={onLogoutEverywhere}>
              Cerrar sesión en todos
            </Button>
            <Button variant="secondary" fullWidth disabled={loggingOut} onClick={() => setConfirming(null)}>
              Cancelar
            </Button>
          </>
        }
      />
    </div>
  );
}
