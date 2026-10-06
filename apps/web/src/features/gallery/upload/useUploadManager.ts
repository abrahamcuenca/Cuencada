import { useSyncExternalStore } from "react";
import { useStore } from "react-redux";
import type { AppStore } from "../../../app/store";
import { getUploadManager, type UploadEntry, type UploadManager } from "./uploadManager";

/**
 * The store's {@link UploadManager} and its current rows.
 *
 * @returns The manager and an immutable snapshot of the upload list.
 */
export function useUploadManager(): { manager: UploadManager; uploads: readonly UploadEntry[] } {
  // react-redux types `useStore` with the base Store; the app always mounts an AppStore (providers.tsx).
  const store = useStore() as AppStore;
  const manager = getUploadManager(store);
  const uploads = useSyncExternalStore(manager.subscribe, manager.getSnapshot, manager.getSnapshot);
  return { manager, uploads };
}
