/**
 * Invite create form: values, defaults and validation against the contract
 * schema (`adminInviteCreateInputSchema`), so the form and the server agree
 * on every rule (admin ⇒ email + sent by email; open ⇒ ≤ 20 uses, ≤ 14 days).
 */
import {
  type AdminInviteCreateRequest,
  adminInviteCreateInputSchema,
  OPEN_INVITE_MAX_DAYS,
  OPEN_INVITE_MAX_USES,
  type UserRole
} from "@cuencada/types";

/** How the invite reaches the person. */
export type InviteDelivery = "email" | "link";

/** Raw form values (text inputs keep strings until validation). */
export interface InviteFormValues {
  delivery: InviteDelivery;
  role: UserRole;
  email: string;
  maxUses: string;
  expiresInDays: string;
  note: string;
}

/** Field names that can carry an error. */
export type InviteFormField = "email" | "maxUses" | "expiresInDays" | "note" | "form";

/** Per-field Spanish errors. */
export type InviteFormErrors = Partial<Record<InviteFormField, string>>;

/** Result of {@link validateInviteForm}. */
export type InviteFormResult = { ok: true; request: AdminInviteCreateRequest } | { ok: false; errors: InviteFormErrors };

/** Form defaults: a member invite sent by email, valid 7 days. */
export const INVITE_FORM_DEFAULTS: InviteFormValues = {
  delivery: "email",
  role: "member",
  email: "",
  maxUses: "10",
  expiresInDays: "7",
  note: ""
};

/** Longest expiry the server accepts for a bound invite. */
export const BOUND_INVITE_MAX_DAYS = 30;

export { OPEN_INVITE_MAX_DAYS, OPEN_INVITE_MAX_USES };

const FIELDS: readonly InviteFormField[] = ["email", "maxUses", "expiresInDays", "note"];

function isField(value: unknown): value is InviteFormField {
  return typeof value === "string" && FIELDS.some((field) => field === value);
}

/** Parses a whole number typed in a form; anything else becomes `NaN` so the schema rejects it. */
function toInt(value: string): number {
  return /^\d+$/.test(value.trim()) ? Number(value.trim()) : Number.NaN;
}

/**
 * Admin invites can only go by email (contract rule), so picking the admin
 * role forces the email delivery.
 *
 * @param values - Current values.
 * @returns The values the form should show.
 */
export function normalizeInviteForm(values: InviteFormValues): InviteFormValues {
  return values.role === "admin" && values.delivery !== "email" ? { ...values, delivery: "email" } : values;
}

/**
 * Builds the `POST /admin/invites` body and validates it with the contract schema.
 *
 * @param input - The raw form values.
 * @returns The request body, or Spanish errors per field.
 */
export function validateInviteForm(input: InviteFormValues): InviteFormResult {
  const values = normalizeInviteForm(input);
  const byEmail = values.delivery === "email";
  const email = values.email.trim();
  const note = values.note.trim();
  if (byEmail && email === "") {
    return {
      ok: false,
      errors: {
        email: values.role === "admin" ? "Una invitación de administrador debe ir a un correo." : "Escribe el correo de la persona."
      }
    };
  }
  const request: AdminInviteCreateRequest = {
    email: byEmail ? email : null,
    role: values.role,
    maxUses: byEmail ? 1 : toInt(values.maxUses),
    expiresInDays: toInt(values.expiresInDays),
    sendEmail: byEmail,
    note: note === "" ? null : note
  };
  const parsed = adminInviteCreateInputSchema.safeParse(request);
  if (parsed.success) return { ok: true, request };

  const errors: InviteFormErrors = {};
  for (const issue of parsed.error.issues) {
    const key = issue.path[0];
    const field: InviteFormField = isField(key) ? key : "form";
    errors[field] ??= numberMessage(field, issue.code) ?? issue.message;
  }
  return { ok: false, errors };
}

/** Plain messages for out-of-range numbers (zod's defaults are generic). */
function numberMessage(field: InviteFormField, code: string): string | null {
  if (code !== "too_big" && code !== "too_small" && code !== "invalid_type") return null;
  if (field === "maxUses") return `Escribe un número de usos entre 1 y ${OPEN_INVITE_MAX_USES}.`;
  if (field === "expiresInDays") return `Escribe un número de días entre 1 y ${BOUND_INVITE_MAX_DAYS}.`;
  return null;
}
