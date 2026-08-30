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
export function withTimeout<T>(
  work: (signal: AbortSignal) => Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  const controller = new AbortController();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      controller.abort(new Error(message));
      reject(new Error(message));
    }, ms);
    work(controller.signal).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (cause: unknown) => {
        clearTimeout(timer);
        reject(cause);
      },
    );
  });
}
