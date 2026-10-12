/**
 * Memory Box error answers (ADR 0001 §4/§8): the top-level `ErrorCode` stays
 * closed; the reason travels in `details[0].code` (`MemoryIssueCode`, path
 * `memoryAlbum`). Messages are Spanish and generic: a draft or hidden box
 * and a missing one answer the same 404.
 */
import { type ApiErrorDetail, MemoryIssueCode } from "@cuencada/types";
import { AppError } from "../../lib/errors.js";

function detail(message: string, code: MemoryIssueCode): ApiErrorDetail[] {
  return [{ path: "memoryAlbum", message, code }];
}

/** 404 for a missing box **or one the caller cannot see** (drafts and hidden boxes for members). */
export function memoryAlbumNotFound(): AppError {
  const message = "No encontramos ese baúl de recuerdos.";
  return new AppError("NOT_FOUND", message, { details: detail(message, MemoryIssueCode.NotFound) });
}

/** 409 on delete while the box still has live media. */
export function memoryAlbumNotEmpty(): AppError {
  const message = "Primero borra las fotos y videos del baúl.";
  return new AppError("CONFLICT", message, { details: detail(message, MemoryIssueCode.NotEmpty) });
}

/** 400 when `coverMediaId` is not a live, ready, approved photo of this box. */
export function memoryCoverInvalid(): AppError {
  const message = "Elige como portada una foto de este baúl.";
  return new AppError("VALIDATION", message, { details: [{ path: "coverMediaId", message }] });
}

/** 409 when the reorder list is not exactly the current set of boxes. */
export function memoryOrderStale(): AppError {
  const message = "La lista de baúles cambió. Vuelve a cargarla e inténtalo de nuevo.";
  return new AppError("CONFLICT", message, { details: [{ path: "ids", message }] });
}

/** 409 when the box limit is reached. */
export function memoryAlbumLimit(max: number): AppError {
  return new AppError("CONFLICT", `Puede haber hasta ${max} baúles de recuerdos.`);
}
