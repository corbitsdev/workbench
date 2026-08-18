/**
 * Holds the one pending retry per workbench whose mint launch stalled on
 * `isSidecarUnavailableLaunchError` (see `routes.ts`'s `POST /workbenches`).
 * The hub's raw sidecar socket `onOpen` (`apps/hub/src/index.ts`) fires
 * before `sidecarRouter.handleOpen`'s registration completes, so a retry
 * fired from it may still find no sidecar routable — the registered retry
 * itself re-marks pending on that outcome, so `retryAll` is safe to call
 * on every socket open with no risk beyond one wasted launch attempt.
 * Consuming an entry before running it makes a retry that re-marks pending
 * (rather than looping) the only way an entry reappears, so concurrent
 * `retryAll` calls never double-fire the same workbench.
 */
export type PendingMintRegistry = {
  markPending(workbenchId: string, retry: () => Promise<void>): void;
  retryAll(): void;
};

export function createPendingMintRegistry(): PendingMintRegistry {
  const pending = new Map<string, () => Promise<void>>();
  return {
    markPending(workbenchId, retry) {
      pending.set(workbenchId, retry);
    },
    retryAll() {
      const retries = [...pending.entries()];
      for (const [workbenchId, retry] of retries) {
        pending.delete(workbenchId);
        void retry();
      }
    },
  };
}
