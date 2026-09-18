// Avoids dispatching before the target page's listener mounts (a race it
// always loses) without a setTimeout guess at when it'll be ready.

export type PendingDialogRequest = {
  /** On-route: dispatch immediately. Off-route: record the pending flag and
   * navigate, so the target page's own mount effect can consume it. */
  readonly request: (args: {
    readonly alreadyOnTargetRoute: boolean;
    readonly navigateToTargetRoute: () => void;
    readonly dispatch: () => void;
  }) => void;
  /** True once if an off-route request is pending; clears the flag. */
  readonly consumePending: () => boolean;
  /** Test helper — drop leftover pending state between cases. */
  readonly resetPending: () => void;
};

export function createPendingDialogRequest(): PendingDialogRequest {
  let pending = false;

  return {
    request({ alreadyOnTargetRoute, navigateToTargetRoute, dispatch }) {
      if (alreadyOnTargetRoute) {
        dispatch();
        return;
      }
      pending = true;
      navigateToTargetRoute();
    },
    consumePending() {
      if (!pending) return false;
      pending = false;
      return true;
    },
    resetPending() {
      pending = false;
    },
  };
}
