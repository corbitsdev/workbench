// Bounded drain for process shutdown. The platform sends SIGTERM and
// expects a prompt exit; a drain that hangs would turn every deploy into
// an apparent crash, so the bound cuts it off. Timing out is not a
// fault -- the process is exiting either way -- but a drain that throws
// is, and the two outcomes are kept distinct so the caller can exit
// non-zero only for the genuine failure.

export type DrainOutcome =
  | { kind: "drained" }
  | { kind: "timed-out" }
  | { kind: "failed"; error: unknown };

export async function drainWithTimeout(
  drain: () => Promise<void>,
  timeoutMs: number,
): Promise<DrainOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<DrainOutcome>((resolve) => {
    timer = setTimeout(() => {
      resolve({ kind: "timed-out" });
    }, timeoutMs);
  });
  const drained = (async (): Promise<DrainOutcome> => {
    try {
      await drain();
      return { kind: "drained" };
    } catch (error) {
      return { kind: "failed", error };
    }
  })();
  const outcome = await Promise.race([drained, timedOut]);
  clearTimeout(timer);
  return outcome;
}
