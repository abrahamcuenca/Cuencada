/**
 * Event error answers (ADR 0001 §4/§7): the top-level `ErrorCode` stays
 * closed; the reason travels in `details[0].code` (`EventIssueCode`).
 * Messages are Spanish, generic and never mention another event, a slug
 * collision or a user.
 */
import { type ApiErrorDetail, EventIssueCode } from "@cuencada/types";
import { AppError } from "../../lib/errors.js";

function detail(message: string, code: EventIssueCode, path = "event"): ApiErrorDetail[] {
  return [{ path, message, code }];
}

/** 404 for a missing **or invisible** event (never 403: no existence leak). */
export function eventNotFound(): AppError {
  const message = "No encontramos ese evento.";
  return new AppError("NOT_FOUND", message, { details: detail(message, EventIssueCode.NotFound) });
}

/** 403: the event is visible, but chat/albums/uploads need a participant. */
export function eventNotParticipant(): AppError {
  const message = "Apúntate al evento para ver el chat y las fotos.";
  return new AppError("FORBIDDEN", message, { details: detail(message, EventIssueCode.NotParticipant) });
}

/** 403: self-join only for published `members` events. */
export function eventJoinNotAllowed(): AppError {
  const message = "Para este evento te tiene que agregar quien lo organiza.";
  return new AppError("FORBIDDEN", message, { details: detail(message, EventIssueCode.JoinNotAllowed) });
}

/** 403: the caller can see the event but is not an organizer or admin. */
export function eventManageNotAllowed(): AppError {
  const message = "Solo quien organiza el evento puede hacer este cambio.";
  return new AppError("FORBIDDEN", message, { details: detail(message, EventIssueCode.ManageNotAllowed) });
}

/** 403: organizers delete only drafts without media. */
export function eventDeleteNotAllowed(): AppError {
  const message = "Solo puedes borrar un borrador sin fotos. Pide ayuda a un administrador.";
  return new AppError("FORBIDDEN", message, { details: detail(message, EventIssueCode.DeleteNotAllowed) });
}

/** 409: the last organizer cannot leave, be removed or be demoted. */
export function eventLastOrganizer(): AppError {
  const message = "El evento necesita al menos una persona que lo organice.";
  return new AppError("CONFLICT", message, { details: detail(message, EventIssueCode.LastOrganizer) });
}

/** 409: delete the album's media first. */
export function eventAlbumNotEmpty(): AppError {
  const message = "Primero borra las fotos y videos del álbum.";
  return new AppError("CONFLICT", message, { details: detail(message, EventIssueCode.AlbumNotEmpty) });
}

/** 409 (admin routes only): the typed slug is taken in that year. */
export function eventSlugTaken(): AppError {
  const message = "Esa dirección ya existe ese año. Elige otra.";
  return new AppError("CONFLICT", message, { details: detail(message, EventIssueCode.SlugTaken, "slug") });
}

/** 404 for an album that is not part of the (visible) event. */
export function albumNotFound(): AppError {
  return new AppError("NOT_FOUND", "No encontramos ese álbum.");
}
