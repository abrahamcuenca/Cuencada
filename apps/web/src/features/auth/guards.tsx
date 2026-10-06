/**
 * Route guards.
 *
 * **UX only [SEC].** These decide what to *render*; they are not access
 * control. The in-memory role and flags can be edited by anyone with devtools.
 * The server enforces authentication, `mustChangePassword` and the admin role
 * on every request, and member-only data never reaches the client without it.
 */
import type { ReactNode } from "react";
import { Navigate, Outlet, useLocation } from "react-router-dom";
import { useAppSelector } from "../../app/hooks";
import { Spinner } from "../../shared/ui/Spinner";
import { selectAuthStatus, selectCurrentUser, selectPasswordChangeRequired } from "./authSlice";
import type { LoginRedirectState } from "./redirect";

/** Path of the login page. */
export const LOGIN_PATH = "/entrar";
/** Path of the forced password-change page. */
export const CHANGE_PASSWORD_PATH = "/cambiar-contrasena";

/** Shown while the boot refresh decides whether there is a session. */
export function SessionPending(): ReactNode {
  return (
    <div className="shell">
      <Spinner size="lg" label="Cargando tu sesión…" />
    </div>
  );
}

/**
 * Renders child routes only with a session. Anonymous users go to `/entrar`
 * with `state.from` set to the requested path + query (never the hash, which
 * may carry tokens). While the boot refresh runs, shows a spinner instead of
 * redirecting.
 *
 * UX only: the server enforces authentication.
 */
export function RequireAuth(): ReactNode {
  const status = useAppSelector(selectAuthStatus);
  const location = useLocation();

  if (status === "idle" || status === "restoring") return <SessionPending />;
  if (status !== "authenticated") {
    const state: LoginRedirectState = { from: `${location.pathname}${location.search}` };
    return <Navigate to={LOGIN_PATH} replace state={state} />;
  }
  return <Outlet />;
}

/**
 * Sends users with a temporary password to `/cambiar-contrasena`. Nest it
 * inside {@link RequireAuth}.
 *
 * UX only: the server answers 403 `PASSWORD_CHANGE_REQUIRED` regardless.
 */
export function RequirePasswordChanged(): ReactNode {
  const mustChange = useAppSelector(selectPasswordChangeRequired);
  if (mustChange) return <Navigate to={CHANGE_PASSWORD_PATH} replace />;
  return <Outlet />;
}

/**
 * Renders child routes only for users whose in-memory role is `admin`;
 * everyone else goes to `/`. Nest it inside {@link RequireAuth}.
 *
 * UX only: **never** trust this role for security. Every `/api/admin/*`
 * route checks the role server-side against the DB session.
 */
export function RequireAdmin(): ReactNode {
  const user = useAppSelector(selectCurrentUser);
  if (user?.role !== "admin") return <Navigate to="/" replace />;
  return <Outlet />;
}
