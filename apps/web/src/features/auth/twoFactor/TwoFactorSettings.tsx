import {
  type TrustedDevice,
  twoFactorDisableInputSchema,
  twoFactorRegenerateInputSchema
} from "@cuencada/types";
import { type FormEvent, type ReactNode, useState } from "react";
import { useAppDispatch } from "../../../app/hooks";
import { isAbortError } from "../../../shared/api/errors";
import { formatDate } from "../../../shared/lib/dates";
import { Badge } from "../../../shared/ui/Badge";
import { Button } from "../../../shared/ui/Button";
import { Card } from "../../../shared/ui/Card";
import { Dialog } from "../../../shared/ui/Dialog";
import { Skeleton } from "../../../shared/ui/Skeleton";
import { useToast } from "../../../shared/ui/Toast";
import { FormAlert } from "../components/FormAlert";
import { PasswordField } from "../components/PasswordField";
import { describeAuthError, usePendingAction, validateForm } from "../forms";
import { formatRelativeTime, PORTAL_TIME_ZONE } from "../sessionDisplay";
import { twoFactorApi, useGetTwoFactorStatusQuery, useListTrustedDevicesQuery, useRevokeTrustedDeviceMutation } from "./api";
import { CodeField, describeTwoFactorError, RecoveryCodeField } from "./fields";
import { EnrollWizard } from "./EnrollWizard";
import { RecoveryCodesPanel } from "./RecoveryCodesPanel";
import styles from "./twoFactor.module.css";

type Open = "enable" | "regenerate" | "disable" | null;

/** Password + code form shared by "Generar códigos nuevos" and "Desactivar". */
function ReauthForm({
  submitLabel,
  danger = false,
  allowRecovery = false,
  onSubmit,
  onCancel
}: {
  submitLabel: string;
  danger?: boolean;
  allowRecovery?: boolean;
  onSubmit: (values: { currentPassword: string; code?: string; recoveryCode?: string }) => Promise<string | null>;
  onCancel: () => void;
}): ReactNode {
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [recoveryCode, setRecoveryCode] = useState("");
  const [useRecovery, setUseRecovery] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const action = usePendingAction();

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    void action.run(async () => {
      const message = await onSubmit(
        useRecovery ? { currentPassword: password, recoveryCode } : { currentPassword: password, code }
      );
      setFormError(message);
      if (message !== null) setCode("");
    });
  };

  return (
    <form className={styles.section} noValidate onSubmit={submit}>
      <PasswordField label="Contraseña actual" name="currentPassword" autoComplete="current-password" value={password} onChange={setPassword} />
      {useRecovery ? <RecoveryCodeField value={recoveryCode} onChange={setRecoveryCode} /> : <CodeField value={code} onChange={setCode} />}
      {allowRecovery ? (
        <button type="button" className={styles.linkButton} onClick={() => setUseRecovery(!useRecovery)}>
          {useRecovery ? "Usar el código de mi app" : "Usar un código de recuperación"}
        </button>
      ) : null}
      <FormAlert message={formError} />
      <Button type="submit" variant={danger ? "danger" : "primary"} fullWidth loading={action.pending}>
        {submitLabel}
      </Button>
      <Button variant="ghost" fullWidth onClick={onCancel}>
        Cancelar
      </Button>
    </form>
  );
}

function DeviceRow({ device, onRemove, removing }: { device: TrustedDevice; onRemove: (id: string) => void; removing: boolean }): ReactNode {
  return (
    <Card as="li" padding="md" className={styles.device}>
      <div className={styles.deviceText}>
        <p className={styles.deviceName}>
          {device.label} {device.current ? <Badge tone="success">Este navegador</Badge> : null}
        </p>
        <p className={styles.muted}>
          {device.lastUsedAt === null ? "Sin usar todavía" : `Último uso: ${formatRelativeTime(device.lastUsedAt)}`} · Vence el{" "}
          {formatDate(device.expiresAt, PORTAL_TIME_ZONE, { dateStyle: "medium" })}
        </p>
      </div>
      <Button variant="secondary" size="sm" loading={removing} onClick={() => onRemove(device.id)} aria-label={`Quitar ${device.label}`}>
        Quitar
      </Button>
    </Card>
  );
}

/** "Dispositivos de confianza": browsers that skip the code for 30 days (members only). */
function TrustedDevices(): ReactNode {
  const toast = useToast();
  const { data: devices, isLoading } = useListTrustedDevicesQuery();
  const [revoke] = useRevokeTrustedDeviceMutation();
  const [removing, setRemoving] = useState<string | null>(null);

  const onRemove = (id: string): void => {
    if (removing !== null) return;
    setRemoving(id);
    revoke(id)
      .unwrap()
      .then(() => toast.show({ message: "Ese dispositivo volverá a pedir el código.", tone: "success" }))
      .catch((cause: unknown) => {
        const message = describeAuthError(cause);
        if (message !== null) toast.show({ message, tone: "danger" });
      })
      .finally(() => setRemoving(null));
  };

  if (isLoading) return <Skeleton shape="block" height={64} />;
  if (devices === undefined || devices.length === 0) {
    return <p className={styles.muted}>Ningún dispositivo de confianza. Al entrar puedes marcar «Confiar en este dispositivo 30 días».</p>;
  }
  return (
    <ul className={styles.deviceList} aria-label="Dispositivos de confianza">
      {devices.map((device) => (
        <DeviceRow key={device.id} device={device} onRemove={onRemove} removing={removing === device.id} />
      ))}
    </ul>
  );
}

/**
 * "Verificación en dos pasos" in Sesiones y seguridad (WP-7): status,
 * "Activar" (wizard), "Generar códigos nuevos", "Desactivar" (members only;
 * administrators see why they cannot) and the trusted devices.
 */
export function TwoFactorSettings(): ReactNode {
  const dispatch = useAppDispatch();
  const toast = useToast();
  const { data: status, isLoading, error } = useGetTwoFactorStatusQuery();
  const [open, setOpen] = useState<Open>(null);
  const [codes, setCodes] = useState<string[] | null>(null);

  const close = (): void => {
    setOpen(null);
    setCodes(null);
  };

  const regenerate = async (values: { currentPassword: string; code?: string }): Promise<string | null> => {
    const validation = validateForm(twoFactorRegenerateInputSchema, { currentPassword: values.currentPassword, code: values.code ?? "" });
    if (!validation.ok) return validation.errors.code ?? validation.errors.currentPassword ?? null;
    try {
      const result = await dispatch(twoFactorApi.endpoints.regenerateRecoveryCodes.initiate(validation.data, { track: false })).unwrap();
      setCodes(result.recoveryCodes);
      return null;
    } catch (cause) {
      return describeTwoFactorError(cause);
    }
  };

  const disable = async (values: { currentPassword: string; code?: string; recoveryCode?: string }): Promise<string | null> => {
    const parsed =
      values.recoveryCode === undefined
        ? validateForm(twoFactorDisableInputSchema, { currentPassword: values.currentPassword, code: values.code ?? "" })
        : validateForm(twoFactorDisableInputSchema, { currentPassword: values.currentPassword, recoveryCode: values.recoveryCode });
    if (!parsed.ok) {
      const errors: Partial<Record<string, string | undefined>> = parsed.errors;
      return errors.code ?? errors.recoveryCode ?? errors.currentPassword ?? null;
    }
    try {
      await dispatch(twoFactorApi.endpoints.disableTwoFactor.initiate(parsed.data, { track: false })).unwrap();
      close();
      toast.show({ message: "Desactivaste la verificación en dos pasos.", tone: "success" });
      return null;
    } catch (cause) {
      return describeTwoFactorError(cause);
    }
  };

  let body: ReactNode;
  if (isLoading) {
    body = <Skeleton shape="block" height={96} />;
  } else if (status === undefined) {
    body = <p className={styles.muted}>{error !== undefined && !isAbortError(error) ? describeAuthError(error) : null}</p>;
  } else if (!status.enabled) {
    body = (
      <>
        <p className={styles.statusRow}>
          <Badge tone="neutral">Desactivada</Badge>
        </p>
        <p className={styles.muted}>
          Además de tu contraseña, te pediremos un código de una app de autenticación en tu teléfono. Así nadie entra a tu cuenta aunque sepa tu
          contraseña.
        </p>
        <Button fullWidth onClick={() => setOpen("enable")}>
          Activar
        </Button>
      </>
    );
  } else {
    body = (
      <>
        <p className={styles.statusRow}>
          <Badge tone="success">Activada</Badge>
          {status.enabledAt === null ? null : (
            <span className={styles.muted}>desde el {formatDate(status.enabledAt, PORTAL_TIME_ZONE, { dateStyle: "medium" })}</span>
          )}
        </p>
        <p className={styles.muted}>
          Te quedan {status.recoveryCodesRemaining} {status.recoveryCodesRemaining === 1 ? "código" : "códigos"} de recuperación.
        </p>
        <Button variant="secondary" fullWidth onClick={() => setOpen("regenerate")}>
          Generar códigos de recuperación nuevos
        </Button>
        {status.required ? (
          <p className={styles.muted}>Los administradores no pueden desactivarla: protege el acceso al Panel de administración.</p>
        ) : (
          <Button variant="danger" fullWidth onClick={() => setOpen("disable")}>
            Desactivar
          </Button>
        )}
        {status.trustDeviceAllowed ? (
          <>
            <h3 className={styles.sectionTitle}>Dispositivos de confianza</h3>
            <TrustedDevices />
          </>
        ) : null}
      </>
    );
  }

  return (
    <section className={styles.section} aria-labelledby="two-factor-title">
      <h2 id="two-factor-title" className={styles.sectionTitle}>
        Verificación en dos pasos
      </h2>
      {body}

      <Dialog open={open === "enable"} onClose={close} title="Activar la verificación en dos pasos" closeOnBackdrop={false}>
        {open === "enable" ? (
          <EnrollWizard
            onCancel={close}
            onFinished={() => {
              close();
              toast.show({ message: "Verificación en dos pasos activada.", tone: "success" });
            }}
          />
        ) : null}
      </Dialog>
      <Dialog open={open === "regenerate"} onClose={close} title="Códigos de recuperación nuevos" closeOnBackdrop={false}>
        {open !== "regenerate" ? null : codes === null ? (
          <>
            <p className={styles.muted}>Los códigos que tienes ahora dejarán de funcionar.</p>
            <ReauthForm submitLabel="Generar códigos nuevos" onSubmit={regenerate} onCancel={close} />
          </>
        ) : (
          <RecoveryCodesPanel codes={codes} onDone={close} />
        )}
      </Dialog>
      <Dialog open={open === "disable"} onClose={close} title="¿Desactivar la verificación en dos pasos?" role="alertdialog" closeOnBackdrop={false}>
        {open === "disable" ? (
          <>
            <p className={styles.muted}>Solo necesitarás tu contraseña para entrar. Quitaremos también tus dispositivos de confianza.</p>
            <ReauthForm submitLabel="Desactivar" danger allowRecovery onSubmit={disable} onCancel={close} />
          </>
        ) : null}
      </Dialog>
    </section>
  );
}
