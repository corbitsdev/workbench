// A wall-clock bound on work that may never settle at all — the shape
// #316 first wrote inline in `platform-adapter.ts` to catch a wedged
// post-deploy mail ack, and CL-6644's turn-level deadline in
// `workbench-service.ts` reuses rather than duplicates. `work`
// rejecting or resolving on its own always wins the race; the timer
// only fires when neither ever happens.
//
// CL-7193: the losing side used to be abandoned outright — nothing told
// it the caller had already given up, so it kept running uncancelled.
// `work` now receives the `AbortSignal` this fires the moment the
// timeout wins, so a caller with something cancellable to do (stop a
// poll loop, close a row it opened) can react instead of running to
// completion unobserved. A `work` that ignores the signal keeps
// today's abandon-on-timeout behavior.
//
// CL-7201: a caller can also hand in its own `externalSignal` — a user
// cancelling the turn this `work` belongs to, say — that cuts `work`
// short exactly like the timeout does, without waiting for the timeout's
// own clock. `work` only ever sees ONE signal regardless of which of the
// two fired, so it never has to reason about "which deadline was this."
// The rejection carries the external signal's own `reason` rather than
// this module's timeout `Error`, so a caller downstream (`dispatchTurn`)
// can tell a real cancellation apart from a genuine timeout.
export function withTimeout<T>(
  work: (signal: AbortSignal) => Promise<T>,
  ms: number,
  message: string,
  externalSignal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      controller.abort(new Error(message));
      reject(new Error(message));
    }, ms);

    const onExternalAbort = () => {
      clearTimeout(timer);
      controller.abort(externalSignal?.reason);
      reject(externalSignal?.reason);
    };
    if (externalSignal?.aborted === true) {
      onExternalAbort();
    } else {
      externalSignal?.addEventListener("abort", onExternalAbort, {
        once: true,
      });
    }

    work(controller.signal).then(
      (value) => {
        clearTimeout(timer);
        externalSignal?.removeEventListener("abort", onExternalAbort);
        resolve(value);
      },
      (cause: unknown) => {
        clearTimeout(timer);
        externalSignal?.removeEventListener("abort", onExternalAbort);
        reject(cause);
      },
    );
  });
}
