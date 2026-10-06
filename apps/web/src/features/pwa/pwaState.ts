/**
 * Client-only PWA state (update available, where the public programa came
 * from, the deferred install prompt). A tiny external store read with
 * `useSyncExternalStore`, not Redux: it holds browser objects (the install
 * event, the update callback) that must not go through the serializable store,
 * and nothing in it is sensitive.
 */
import { useSyncExternalStore } from "react";
import type { PublicApiSource } from "./swRules";

/**
 * Chromium's `beforeinstallprompt` event (not in TypeScript's DOM lib).
 * Only the members we use.
 */
export interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  readonly userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
}

/** Applies the waiting service worker; the page reloads once it takes control. */
export type ApplyUpdate = () => Promise<void>;

/** Snapshot of the PWA state. Replaced (never mutated) on every change. */
export interface PwaState {
  /** A new version is installed and waiting; `applyUpdate` activates it. */
  applyUpdate: ApplyUpdate | null;
  /** Source of the last public Cuencada read answered by the service worker. */
  publicApiSource: PublicApiSource | null;
  /** Deferred `beforeinstallprompt` (Android/Chromium), or `null`. */
  installPrompt: BeforeInstallPromptEvent | null;
}

const INITIAL_STATE: PwaState = { applyUpdate: null, publicApiSource: null, installPrompt: null };

let state: PwaState = INITIAL_STATE;
const listeners = new Set<() => void>();

/** @returns The current snapshot. */
export function getPwaState(): PwaState {
  return state;
}

/**
 * Merges a patch into the state and notifies subscribers.
 *
 * @param patch - Fields to change.
 */
export function updatePwaState(patch: Partial<PwaState>): void {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

/**
 * @param listener - Called after every change.
 * @returns Unsubscribe.
 */
export function subscribePwaState(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Back to the initial state (tests). */
export function resetPwaState(): void {
  updatePwaState(INITIAL_STATE);
}

/** @returns The live PWA state. */
export function usePwaState(): PwaState {
  return useSyncExternalStore(subscribePwaState, getPwaState, getPwaState);
}
