import { type ReactNode, useState } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { useAppDispatch, useAppSelector } from "../../../app/hooks";
import { reportUnexpected } from "../../../shared/lib/reportUnexpected";
import { Button } from "../../../shared/ui/Button";
import { Spinner } from "../../../shared/ui/Spinner";
import { selectPasswordChangeRequired, selectTwoFactorSetupRequired } from "../authSlice";
import { AuthLayout } from "../components/AuthLayout";
import { CHANGE_PASSWORD_PATH, LOGIN_PATH } from "../guards";
import { logout } from "../session";
import { useGetTwoFactorStatusQuery } from "./api";
import { EnrollWizard } from "./EnrollWizard";
import styles from "./twoFactor.module.css";

/** Where an administrator lands after enrolling. */
const AFTER_ENROLL_PATH = "/admin";

/**
 * `/activar-verificacion` (WP-7): the enrollment gate for administrators.
 * Every other route answers 403 `TWO_FACTOR_SETUP_REQUIRED` until they
 * enroll; the router sends them here. After "Ya los guardé" they continue to
 * the admin panel. Members who open it are sent home.
 */
export function EnrollTwoFactorPage(): ReactNode {
  const dispatch = useAppDispatch();
  const navigate = useNavigate();
  const required = useAppSelector(selectTwoFactorSetupRequired);
  const mustChangePassword = useAppSelector(selectPasswordChangeRequired);
  // Once enabled the flag clears while the recovery codes are still on screen; stay until "Ya los guardé".
  const [enrolling] = useState(required);
  const { data: status, isLoading } = useGetTwoFactorStatusQuery(undefined, { skip: !required || mustChangePassword });

  if (mustChangePassword) return <Navigate to={CHANGE_PASSWORD_PATH} replace />;
  if (!required && !enrolling) return <Navigate to="/" replace />;

  const signOut = (): void => {
    dispatch(logout())
      .then(() => navigate(LOGIN_PATH, { replace: true }))
      .catch(reportUnexpected);
  };

  // A promoted member who already had 2FA but whose session skipped the code: log in again with it.
  if (required && status?.enabled === true) {
    return (
      <AuthLayout title="Vuelve a entrar con tu código" icon="🔐" lead="Tu cuenta ya tiene la verificación en dos pasos. Cierra sesión y entra otra vez con el código de tu app.">
        <Button fullWidth size="lg" onClick={signOut}>
          Cerrar sesión
        </Button>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title="Activa la verificación en dos pasos"
      icon="🔐"
      lead="Por seguridad, los administradores deben activar la verificación en dos pasos. Necesitas una app de autenticación en tu teléfono."
    >
      {isLoading ? (
        <Spinner size="lg" label="Cargando…" />
      ) : (
        <EnrollWizard
          onFinished={() => void navigate(AFTER_ENROLL_PATH, { replace: true })}
        />
      )}
      <p className={styles.muted}>
        ¿No puedes hacerlo ahora?{" "}
        <button type="button" className={styles.linkButton} onClick={signOut}>
          Cerrar sesión
        </button>
      </p>
    </AuthLayout>
  );
}
