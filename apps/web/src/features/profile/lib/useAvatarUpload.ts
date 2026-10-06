/**
 * Avatar upload: local preview, then intent → direct PUT to the bucket →
 * confirm, with progress. Same pipeline and guards as the gallery (WP-T4-FE):
 *
 * - [SEC] the intent is validated with `avatarUploadResponseSchema` and its
 *   `uploadUrl` must be on `VITE_MEDIA_UPLOAD_ORIGIN` (unset: refused), so the
 *   photo is never PUT anywhere else;
 * - the PUT sends only the signed headers, without cookies or `Authorization`;
 * - the signed URL never reaches the UI or a log.
 *
 * The preview is an object URL, revoked when it is replaced, when the upload
 * ends (success or failure) and on unmount. Unmounting also aborts the upload.
 */
import { type AvatarUploadInput, type AvatarUploadResponse, avatarUploadInputSchema, avatarUploadResponseSchema } from "@cuencada/types";
import { useCallback, useEffect, useRef, useState } from "react";
import { getApiErrorCode, isAbortError } from "../../../shared/api/errors";
import { env } from "../../../shared/lib/env";
import { putToPresignedUrl, UploadTransferError } from "../../gallery/lib/putToPresignedUrl";
import { isAllowedUploadUrl } from "../../gallery/lib/uploadOrigin";
import { useConfirmAvatarMutation, useCreateAvatarUploadMutation } from "../api";

/** Exactly the contract allowlist (`avatarMimeTypeSchema`). */
export const AVATAR_ACCEPT = "image/jpeg,image/png,image/webp";

/** Shown for every failure after the file was accepted (wireframe copy). */
export const AVATAR_UPLOAD_FAILED = "No pudimos subir la foto. Inténtalo otra vez.";

/** Where the upload is. */
export type AvatarUploadPhase = "idle" | "uploading" | "confirming" | "done" | "error";

/** State exposed by {@link useAvatarUpload}. */
export interface AvatarUploadState {
  phase: AvatarUploadPhase;
  /** 0..1 while uploading. */
  progress: number;
  /** Object URL of the picked file while it uploads, else `null`. */
  previewUrl: string | null;
  /** Spanish error, or `null`. */
  error: string | null;
}

/** What {@link useAvatarUpload} returns. */
export interface AvatarUploadApi extends AvatarUploadState {
  /** Validates and uploads a picked file. Ignored while an upload runs. */
  start: (file: File) => void;
}

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp" };

/**
 * Client-side check before anything is sent (the server checks again).
 *
 * @param file - The picked file.
 * @returns The validated MIME type and size, or a Spanish error.
 */
export function validateAvatarFile(file: File): { ok: true; input: AvatarUploadInput } | { ok: false; error: string } {
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  const mimeType = file.type === "" ? (MIME_BY_EXTENSION[extension] ?? "") : file.type;
  const parsed = avatarUploadInputSchema.safeParse({ mimeType, byteSize: file.size });
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "No pudimos usar ese archivo." };
  return { ok: true, input: parsed.data };
}

/**
 * Validates the intent: it is the one response whose URL the browser sends a
 * file to, so its shape and origin are checked, not trusted [SEC].
 *
 * @param raw - The intent response.
 * @returns The intent, or `null` when it must not be used.
 */
export function parseAvatarIntent(raw: unknown): AvatarUploadResponse | null {
  const parsed = avatarUploadResponseSchema.safeParse(raw);
  if (!parsed.success || !isAllowedUploadUrl(parsed.data.uploadUrl, env.mediaUploadOrigin)) return null;
  return parsed.data;
}

/** Spanish message for a failure; `null` for an abort (nothing to show). */
function describeFailure(error: unknown): string | null {
  if (isAbortError(error)) return null;
  if (error instanceof UploadTransferError) return error.failure === "aborted" ? null : AVATAR_UPLOAD_FAILED;
  if (getApiErrorCode(error) === "RATE_LIMITED") return "Demasiados intentos. Espera unos minutos y vuelve a intentarlo.";
  return AVATAR_UPLOAD_FAILED;
}

const IDLE: AvatarUploadState = { phase: "idle", progress: 0, previewUrl: null, error: null };

/**
 * @returns Upload state and `start(file)`.
 */
export function useAvatarUpload(): AvatarUploadApi {
  const [createUpload] = useCreateAvatarUploadMutation();
  const [confirmAvatar] = useConfirmAvatarMutation();
  const [state, setState] = useState<AvatarUploadState>(IDLE);
  const previewRef = useRef<string | null>(null);
  const controllerRef = useRef<AbortController | null>(null);

  const setPreview = useCallback((url: string | null): void => {
    if (previewRef.current !== null) URL.revokeObjectURL(previewRef.current);
    previewRef.current = url;
  }, []);

  useEffect(
    () => () => {
      controllerRef.current?.abort();
      if (previewRef.current !== null) URL.revokeObjectURL(previewRef.current);
      previewRef.current = null;
    },
    []
  );

  const run = useCallback(
    async (file: File, input: AvatarUploadInput, controller: AbortController): Promise<void> => {
      const fail = (error: unknown): void => {
        if (controller.signal.aborted) return;
        setPreview(null);
        const message = describeFailure(error);
        setState(message === null ? IDLE : { ...IDLE, phase: "error", error: message });
      };

      try {
        const request = createUpload(input);
        const abortRequest = (): void => request.abort();
        controller.signal.addEventListener("abort", abortRequest, { once: true });
        // `reset` drops the intent (and its signed URL) from the store once read.
        const raw: unknown = await request.unwrap().finally(() => {
          controller.signal.removeEventListener("abort", abortRequest);
          request.reset();
        });
        if (controller.signal.aborted) return;
        const intent = parseAvatarIntent(raw);
        if (intent === null) {
          fail(new Error("Respuesta de subida inválida."));
          return;
        }

        let lastPercent = -1;
        await putToPresignedUrl({
          url: intent.uploadUrl,
          headers: intent.headers,
          body: file,
          signal: controller.signal,
          onProgress: (fraction) => {
            const percent = Math.floor(fraction * 100);
            if (percent === lastPercent) return;
            lastPercent = percent;
            setState((current) => ({ ...current, progress: fraction }));
          }
        });
        if (controller.signal.aborted) return;

        setState((current) => ({ ...current, phase: "confirming", progress: 1 }));
        const confirm = confirmAvatar({ uploadId: intent.uploadId });
        await confirm.unwrap();
        if (controller.signal.aborted) return;
        setPreview(null);
        setState({ ...IDLE, phase: "done" });
      } catch (error) {
        fail(error);
      } finally {
        if (controllerRef.current === controller) controllerRef.current = null;
      }
    },
    [confirmAvatar, createUpload, setPreview]
  );

  const start = useCallback(
    (file: File): void => {
      if (controllerRef.current !== null) return;
      const checked = validateAvatarFile(file);
      if (!checked.ok) {
        setPreview(null);
        setState({ ...IDLE, phase: "error", error: checked.error });
        return;
      }
      const controller = new AbortController();
      controllerRef.current = controller;
      const url = URL.createObjectURL(file);
      setPreview(url);
      setState({ phase: "uploading", progress: 0, previewUrl: url, error: null });
      void run(file, checked.input, controller);
    },
    [run, setPreview]
  );

  return { ...state, start };
}
