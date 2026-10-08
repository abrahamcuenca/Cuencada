/**
 * Labels and types of the add-relative sheet, kept apart from the (lazy)
 * sheet itself so the tree page can render its buttons without loading it.
 */

/** Which group of the tree a relative is added to. */
export type RelativeRole = "parent" | "partner" | "child";

/** Button label and sheet title per group. */
export const ADD_RELATIVE_LABELS: Record<RelativeRole, string> = {
  parent: "Agregar padre o madre",
  partner: "Agregar pareja",
  child: "Agregar hijo/a"
};

/** Note for members, who cannot link people already in the tree. */
export const MEMBER_LINK_NOTE = "¿Ya está en el árbol? Pídele a un administrador que los conecte.";
