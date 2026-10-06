import type { AvatarConfirmRequest, AvatarUploadRequest, AvatarUploadResponse, OwnProfile, UpdateProfileRequest } from "@cuencada/types";
import { baseApi } from "../../shared/api/baseApi";
import { refreshCurrentUser } from "../auth/api";

/** Cache tag of the caller's own profile. */
const PROFILE_TAG = { type: "Profile", id: "ME" } as const;

/** The caller's own directory entry and the lists that may show it. */
function directoryTags(userId: string): { type: "Directory"; id: string }[] {
  return [
    { type: "Directory", id: userId },
    { type: "Directory", id: "LIST" }
  ];
}

/**
 * Profile endpoints (T5): the caller's own profile and the avatar upload
 * (intent → direct PUT to the bucket → confirm). The intent is validated by
 * `useAvatarUpload`, not here, so its signed URL never reaches an error toast.
 *
 * Writes replace the cached profile with the server's answer and refetch
 * `/me`, so the header avatar and name follow without a reload. They also
 * invalidate the caller's own directory entry.
 */
export const profileApi = baseApi.injectEndpoints({
  endpoints: (build) => ({
    /** `GET /profile/me`. */
    getProfile: build.query<OwnProfile, void>({
      query: () => "/profile/me",
      providesTags: [PROFILE_TAG]
    }),

    /** `PATCH /profile/me` with the changed fields only. */
    updateProfile: build.mutation<OwnProfile, UpdateProfileRequest>({
      query: (body) => ({ url: "/profile/me", method: "PATCH", body }),
      async onQueryStarted(_patch, { dispatch, queryFulfilled }) {
        const saved = await queryFulfilled.then(({ data }) => data).catch(() => null);
        if (saved === null) return; // The page shows the error.
        dispatch(profileApi.util.upsertQueryData("getProfile", undefined, saved));
        dispatch(refreshCurrentUser());
      },
      invalidatesTags: (result) => (result ? directoryTags(result.userId) : [])
    }),

    /** `POST /profile/me/avatar/uploads`: the presigned PUT. */
    createAvatarUpload: build.mutation<AvatarUploadResponse, AvatarUploadRequest>({
      query: (body) => ({ url: "/profile/me/avatar/uploads", method: "POST", body })
    }),

    /** `POST /profile/me/avatar/confirm`: the server checks the object and returns the updated profile. */
    confirmAvatar: build.mutation<OwnProfile, AvatarConfirmRequest>({
      query: (body) => ({ url: "/profile/me/avatar/confirm", method: "POST", body }),
      async onQueryStarted(_body, { dispatch, queryFulfilled }) {
        const saved = await queryFulfilled.then(({ data }) => data).catch(() => null);
        if (saved === null) return; // The avatar editor shows the error.
        dispatch(profileApi.util.upsertQueryData("getProfile", undefined, saved));
        dispatch(refreshCurrentUser());
      },
      invalidatesTags: (result) => (result ? directoryTags(result.userId) : [])
    }),

    /** `DELETE /profile/me/avatar`: removes the photo and returns the updated profile. */
    deleteAvatar: build.mutation<OwnProfile, void>({
      query: () => ({ url: "/profile/me/avatar", method: "DELETE" }),
      async onQueryStarted(_arg, { dispatch, queryFulfilled }) {
        const saved = await queryFulfilled.then(({ data }) => data).catch(() => null);
        if (saved === null) return; // The avatar editor shows the error.
        dispatch(profileApi.util.upsertQueryData("getProfile", undefined, saved));
        dispatch(refreshCurrentUser());
      },
      invalidatesTags: (result) => (result ? directoryTags(result.userId) : [])
    })
  })
});

export const { useGetProfileQuery, useUpdateProfileMutation, useCreateAvatarUploadMutation, useConfirmAvatarMutation, useDeleteAvatarMutation } = profileApi;
