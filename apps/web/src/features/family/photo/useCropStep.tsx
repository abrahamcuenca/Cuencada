/**
 * "Pick → frame → upload" glue shared by the avatar editor and the tree
 * photo editor (WP-4.3). The cropper is a lazy chunk, fetched only when a
 * file has been picked.
 */
import { type ReactNode, Suspense, lazy, useCallback, useState } from "react";
import { uploadsConfigured } from "../../gallery/lib/uploadOrigin";
import { AVATAR_UPLOADS_UNAVAILABLE, validateAvatarFile } from "../../profile/lib/useAvatarUpload";

const ImageCropper = lazy(async () => ({ default: (await import("./ImageCropper")).ImageCropper }));

/** What {@link useCropStep} returns. */
export interface CropStep {
  /** Hand it the picked file: the type is checked, then the cropper opens. */
  pick: (file: File) => void;
  /** A type error for the picked file (Spanish), or `null`. */
  pickError: string | null;
  /** Render this somewhere in the editor: the cropper dialog while a file is being framed. */
  cropper: ReactNode;
}

/** Options of {@link useCropStep} beyond the title (WP-5.4). */
export interface CropStepOptions {
  /** Frame width / height: 1 (default, circle) or e.g. 16/9 for event covers. */
  aspect?: number;
  /** Hint under the cropper title. */
  description?: string;
}

/**
 * @param onCropped - Receives the cropped JPEG (1024×1024 for a square; e.g. `upload.start`).
 * @param title - Cropper title (default "Ajustar foto").
 * @param options - Aspect ratio and hint of the cropper.
 */
export function useCropStep(onCropped: (file: File) => void, title?: string, options: CropStepOptions = {}): CropStep {
  const [file, setFile] = useState<File | null>(null);
  const [pickError, setPickError] = useState<string | null>(null);

  const pick = useCallback((picked: File): void => {
    const checked = validateAvatarFile(picked, { typeOnly: true });
    if (!checked.ok) {
      setPickError(checked.error);
      return;
    }
    // Same gate as the upload itself: don't let someone frame a photo that can't be sent.
    if (!uploadsConfigured()) {
      setPickError(AVATAR_UPLOADS_UNAVAILABLE);
      return;
    }
    setPickError(null);
    setFile(picked);
  }, []);

  const cropper =
    file === null ? null : (
      <Suspense fallback={null}>
        <ImageCropper
          file={file}
          {...(title === undefined ? {} : { title })}
          {...(options.aspect === undefined ? {} : { aspect: options.aspect })}
          {...(options.description === undefined ? {} : { description: options.description })}
          onCancel={() => setFile(null)}
          onCropped={(cropped) => {
            setFile(null);
            onCropped(cropped);
          }}
        />
      </Suspense>
    );

  return { pick, pickError, cropper };
}
