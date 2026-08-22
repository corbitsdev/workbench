// A wall-clock bound on a promise that may never settle at all — the
// shape #316 first wrote inline in `platform-adapter.ts` to catch a
// wedged post-deploy mail ack, and CL-6644's turn-level deadline in
// `workbench-service.ts` reuses rather than duplicates. `promise`
// rejecting or resolving on its own always wins the race; the timer
// only fires when neither ever happens.
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
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
