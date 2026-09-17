// Generalizes the pending-flag pattern `library-upload.ts` already uses for
// cross-route dialog triggers: a caller may fire "open this dialog" from a
// page other than the one that owns it, before that page (and its
// window-event listener) has mounted. Dispatching the event immediately in
// that case is a race the listener always loses. Recording a one-shot
// pending flag and consuming it once the target page mounts avoids both the
// race and a setTimeout guess at when the listener will be ready.

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
