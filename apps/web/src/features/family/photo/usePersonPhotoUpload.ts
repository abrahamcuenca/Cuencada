/**
 * Tree-photo upload (WP-4.3): the avatar upload flow (`usePhotoUpload`: origin
 * check of the presigned URL, credential-less PUT, abort on unmount) pointed
 * at the person's photo endpoints.
 */
import { useMemo } from "react";
import { type AvatarUploadApi, type PhotoUploadEndpoints, usePhotoUpload } from "../../profile/lib/useAvatarUpload";
import { useConfirmPersonPhotoMutation, useCreatePersonPhotoUploadMutation } from "../api";

/**
 * @param personId - The person whose tree photo is uploaded.
 * @returns Upload state and `start(file)` (pass the cropper's JPEG).
 */
export function usePersonPhotoUpload(personId: string): AvatarUploadApi {
  const [createUpload] = useCreatePersonPhotoUploadMutation();
  const [confirmPhoto] = useConfirmPersonPhotoMutation();
  const endpoints = useMemo<PhotoUploadEndpoints>(
    () => ({
      createUpload: (input) => createUpload({ personId, ...input }),
      confirm: (uploadId) => confirmPhoto({ personId, uploadId })
    }),
    [createUpload, confirmPhoto, personId]
  );
  return usePhotoUpload(endpoints);
}
