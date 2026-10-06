import { lazy, type ReactNode, Suspense } from "react";
import { reportUnexpected } from "../../shared/lib/reportUnexpected";
import { installPwaListeners } from "./pwaListeners";

// At module evaluation (initial chunk): before React renders and before the first API request.
installPwaListeners();

/** Renders nothing: what the PWA status becomes when its chunk cannot load. */
function NoPwaStatus(): ReactNode {
  return null;
}

// Lazy: keeps the registration code and banners out of the initial chunk.
// Fails soft (offline before the first install, stale tab after a deploy):
// the layout must never fall to its error boundary because of this.
const PwaStatus = lazy(() =>
  import("./PwaStatus").then(
    (module) => ({ default: module.PwaStatus }),
    (error: unknown) => {
      reportUnexpected(error);
      return { default: NoPwaStatus };
    }
  )
);

/**
 * Mounted once by `AppLayout`: service worker registration, the update
 * prompt and the offline notice (see `PwaStatus`).
 */
export function PwaStatusMount(): ReactNode {
  return (
    <Suspense fallback={null}>
      <PwaStatus />
    </Suspense>
  );
}
