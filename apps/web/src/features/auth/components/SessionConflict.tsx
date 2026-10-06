import { type ReactNode, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAppDispatch, useAppSelector } from "../../../app/hooks";
import { reportUnexpected } from "../../../shared/lib/reportUnexpected";
import { Button } from "../../../shared/ui/Button";
import { Spinner } from "../../../shared/ui/Spinner";
import styles from "../auth.module.css";
import { selectAuthStatus, selectCurrentUser } from "../authSlice";
import { logout } from "../session";
import { AuthLayout } from "./AuthLayout";

/**
 * Where a fragment-token page stands with respect to the current session:
 * - `waiting`: the boot refresh has not decided yet; show a spinner and do nothing.
 * - `conflict`: someone is logged in; the link must not run until they choose.
 * - `clear`: nobody is logged in.
 */
export type SessionGate = "waiting" | "conflict" | "clear";

/**
 * [SEC] Login-CSRF / silent account switching guard (Security M1). Token
 * pages (magic link, invite, reset, verify) call this before doing anything
 * with the token.
 *
 * @returns The gate for the current auth status.
 */
export function useSessionGate(): SessionGate {
  const status = useAppSelector(selectAuthStatus);
  if (status === "idle" || status === "restoring") return "waiting";
  return status === "authenticated" ? "conflict" : "clear";
}

/** Props for {@link SessionConflict}. */
export interface SessionConflictProps {
  /** Heading of the page the link opened. */
  title: string;
  /** e.g. "entrar con este enlace", "aceptar la invitación". */
  action: string;
  /** Called after the logout finished; the page then continues with the token. */
  onLoggedOut: () => void;
  /** Called when the user keeps the current session; the page discards the token. */
  onKeep: () => void;
}

/** Shown by token pages while {@link useSessionGate} is `waiting`. */
export function SessionGateWaiting({ title }: { title: string }): ReactNode {
  return (
    <AuthLayout title={title}>
      <Spinner size="lg" label="Cargando tu sesión…" />
    </AuthLayout>
  );
}

/**
 * "Ya tienes la sesión abierta como X" interstitial. Switching accounts is
 * always an explicit, visible choice: "Cerrar sesión y continuar" awaits the
 * regular `logout()` (epoch bump, cache reset, broadcast, server call) before
 * the page uses the token; "Seguir como X" drops the token and goes home.
 */
export function SessionConflict({ title, action, onLoggedOut, onKeep }: SessionConflictProps): ReactNode {
  const dispatch = useAppDispatch();
  const navigate = useNavigate();
  const user = useAppSelector(selectCurrentUser);
  const [leaving, setLeaving] = useState(false);
  const name = user?.displayName ?? "otra cuenta";

  const onSwitch = (): void => {
    if (leaving) return;
    setLeaving(true);
    dispatch(logout())
      .then(() => onLoggedOut())
      .catch((error: unknown) => {
        setLeaving(false);
        reportUnexpected(error);
      });
  };

  const onStay = (): void => {
    onKeep();
    void navigate("/", { replace: true });
  };

  return (
    <AuthLayout title={title} icon="👤">
      {/* Inner <p>: `.notice` is a grid, which would split the text and <strong> into rows. */}
      <div className={styles.notice}>
        <p>
          Ya tienes la sesión abierta como <strong translate="no">{name}</strong>. ¿Quieres cerrar sesión y {action}?
        </p>
      </div>
      <div className={styles.actions}>
        <Button fullWidth size="lg" loading={leaving} onClick={onSwitch}>
          Cerrar sesión y continuar
        </Button>
        <Button variant="secondary" fullWidth disabled={leaving} onClick={onStay}>
          Seguir como {name}
        </Button>
      </div>
    </AuthLayout>
  );
}
