/**
 * Spanish labels for the admin console's enums. Unknown values (older audit
 * rows, actions added by other tracks) fall back to the raw string.
 */
import { AuditAction, AuditEntityType, type InviteStatus, type UserRole, type UserStatus } from "@cuencada/types";
import type { BadgeTone } from "../../../shared/ui/Badge";

/** Role names. */
export const ROLE_LABEL: Record<UserRole, string> = { member: "Miembro", admin: "Administrador" };

/** Account status names. */
export const USER_STATUS_LABEL: Record<UserStatus, string> = { active: "Activa", disabled: "Deshabilitada" };

/** Invite status names and badge tones. */
export const INVITE_STATUS: Record<InviteStatus, { label: string; tone: BadgeTone }> = {
  pending: { label: "Pendiente", tone: "accent" },
  accepted: { label: "Aceptada", tone: "success" },
  revoked: { label: "Revocada", tone: "neutral" },
  expired: { label: "Caducada", tone: "neutral" }
};

const ACTION_LABELS: Record<AuditAction, string> = {
  [AuditAction.UserUpdated]: "Cambió una cuenta",
  [AuditAction.UserDisabled]: "Deshabilitó una cuenta",
  [AuditAction.UserEnabled]: "Habilitó una cuenta",
  [AuditAction.UserSessionsRevoked]: "Cerró las sesiones de una cuenta",
  [AuditAction.UserPasswordResetForced]: "Forzó un cambio de contraseña",
  [AuditAction.UserEmailVerifiedByAdmin]: "Marcó un correo como verificado",
  [AuditAction.RefreshReuseDetected]: "Reúso de sesión detectado",
  [AuditAction.RefreshRace]: "Renovación de sesión simultánea",
  [AuditAction.PasswordChanged]: "Cambió su contraseña",
  [AuditAction.PasswordReset]: "Restableció su contraseña",
  [AuditAction.LoggedIn]: "Entró",
  [AuditAction.LoginFailed]: "Intento de entrada fallido",
  [AuditAction.LoggedOut]: "Cerró sesión",
  [AuditAction.SessionRevoked]: "Cerró una de sus sesiones",
  [AuditAction.SessionsRevoked]: "Cerró varias de sus sesiones",
  [AuditAction.PasswordResetRequested]: "Pidió restablecer su contraseña",
  [AuditAction.MagicLinkRequested]: "Pidió un enlace para entrar",
  [AuditAction.EmailVerificationRequested]: "Pidió verificar su correo",
  [AuditAction.EmailVerified]: "Verificó su correo",
  [AuditAction.ProfileUpdated]: "Editó su perfil",
  [AuditAction.ProfileAvatarUpdated]: "Cambió su foto de perfil",
  [AuditAction.ProfileAvatarRemoved]: "Quitó su foto de perfil",
  [AuditAction.ProfileAvatarRejected]: "Foto de perfil rechazada",
  [AuditAction.InviteCreated]: "Creó una invitación",
  [AuditAction.InviteRevoked]: "Revocó una invitación",
  [AuditAction.InviteResent]: "Reenvió una invitación",
  [AuditAction.InviteAccepted]: "Aceptó una invitación",
  [AuditAction.CuencadaCreated]: "Creó una Cuencada",
  [AuditAction.CuencadaUpdated]: "Editó una Cuencada",
  [AuditAction.CuencadaPublished]: "Publicó una Cuencada",
  [AuditAction.CuencadaUnpublished]: "Despublicó una Cuencada",
  [AuditAction.CuencadaDeleted]: "Eliminó una Cuencada",
  [AuditAction.DailyMessagesImported]: "Importó mensajes del día",
  [AuditAction.DailyMessageSaved]: "Guardó un mensaje del día",
  [AuditAction.DailyMessageDeleted]: "Eliminó un mensaje del día",
  [AuditAction.ItineraryItemCreated]: "Agregó una actividad",
  [AuditAction.ItineraryItemUpdated]: "Editó una actividad",
  [AuditAction.ItineraryItemDeleted]: "Eliminó una actividad",
  [AuditAction.ItineraryReordered]: "Reordenó el itinerario",
  [AuditAction.LocationCreated]: "Agregó un lugar",
  [AuditAction.LocationUpdated]: "Editó un lugar",
  [AuditAction.LocationDeleted]: "Eliminó un lugar",
  [AuditAction.LocationsReordered]: "Reordenó los lugares",
  [AuditAction.AnnouncementCreated]: "Publicó un aviso",
  [AuditAction.AnnouncementUpdated]: "Editó un aviso",
  [AuditAction.AnnouncementDeleted]: "Eliminó un aviso",
  [AuditAction.AttendanceUpdated]: "Actualizó la asistencia",
  [AuditAction.RsvpSaved]: "Confirmó o cambió su asistencia",
  [AuditAction.RsvpExported]: "Descargó las confirmaciones",
  [AuditAction.MediaModerated]: "Moderó una foto",
  [AuditAction.MediaUploaded]: "Subió una foto o video",
  [AuditAction.MediaUploadRejected]: "Subida rechazada",
  [AuditAction.MediaUpdated]: "Editó una foto",
  [AuditAction.MediaDeleted]: "Eliminó una foto",
  [AuditAction.MediaReported]: "Reportó una foto",
  [AuditAction.PersonCreated]: "Agregó a una persona",
  [AuditAction.PersonUpdated]: "Editó a una persona",
  [AuditAction.PersonDeleted]: "Eliminó a una persona",
  [AuditAction.RelationshipCreated]: "Agregó un parentesco",
  [AuditAction.RelationshipDeleted]: "Eliminó un parentesco",
  [AuditAction.ChatMessageDeleted]: "Eliminó un mensaje del chat"
};

const ENTITY_LABELS: Record<AuditEntityType, string> = {
  [AuditEntityType.User]: "Cuenta",
  [AuditEntityType.Session]: "Sesión",
  [AuditEntityType.Invite]: "Invitación",
  [AuditEntityType.Profile]: "Perfil",
  [AuditEntityType.Cuencada]: "Cuencada",
  [AuditEntityType.ItineraryItem]: "Actividad",
  [AuditEntityType.Location]: "Lugar",
  [AuditEntityType.Announcement]: "Aviso",
  [AuditEntityType.DailyMessage]: "Mensaje del día",
  [AuditEntityType.Rsvp]: "Confirmación",
  [AuditEntityType.Attendance]: "Asistencia",
  [AuditEntityType.Media]: "Foto o video",
  [AuditEntityType.Person]: "Persona",
  [AuditEntityType.Relationship]: "Parentesco",
  [AuditEntityType.ChatMessage]: "Mensaje del chat"
};

function hasKey<TKey extends string>(record: Record<TKey, string>, key: string): key is TKey {
  return Object.hasOwn(record, key);
}

/**
 * @param action - A dotted audit action, e.g. `user.disabled`.
 * @returns Its Spanish label, or the raw action for one this build doesn't know.
 */
export function auditActionLabel(action: string): string {
  return hasKey(ACTION_LABELS, action) ? ACTION_LABELS[action] : action;
}

/**
 * @param entityType - An audit entity type, e.g. `invite`.
 * @returns Its Spanish label, or the raw value for an unknown (older) one.
 */
export function auditEntityLabel(entityType: string): string {
  return hasKey(ENTITY_LABELS, entityType) ? ENTITY_LABELS[entityType] : entityType;
}

/** Options for the "Acción" filter, sorted by label. */
export const AUDIT_ACTION_OPTIONS: ReadonlyArray<{ value: string; label: string }> = Object.values(AuditAction)
  .map((value) => ({ value, label: `${ACTION_LABELS[value]} (${value})` }))
  .sort((a, b) => a.label.localeCompare(b.label, "es"));

/** Options for the "Tipo" filter, sorted by label. */
export const AUDIT_ENTITY_OPTIONS: ReadonlyArray<{ value: string; label: string }> = Object.values(AuditEntityType)
  .map((value) => ({ value, label: ENTITY_LABELS[value] }))
  .sort((a, b) => a.label.localeCompare(b.label, "es"));
