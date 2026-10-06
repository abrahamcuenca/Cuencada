import type { ReactNode } from "react";
import { Button } from "../../../shared/ui/Button";
import { EmptyState } from "../../../shared/ui/EmptyState";

/** An unknown `/admin/…` path: point back to the dashboard (the section list is beside it at ≥900px). */
export function AdminNotFoundPage(): ReactNode {
  return (
    <EmptyState
      icon="🧭"
      headingLevel={2}
      title="No encontramos esta sección de administración"
      description="Puede que el enlace esté mal escrito. Elige una sección desde el resumen."
      action={<Button to="/admin">Ir al resumen</Button>}
    />
  );
}
