// Bounded drain for process shutdown, mirroring apps/sidecar/src/shutdown.ts's
// shape. Kept as a local copy rather than a shared import or package: it's a
// ~15-line primitive, and the two apps already diverge on exit semantics
// (the sidecar treats a timeout as a clean-enough exit; the hub treats a
// timeout as a fault worth reporting), so sharing it would need a parameter
// immediately.
//
// The platform sends SIGTERM and expects a prompt exit; a drain that hangs
// would turn every deploy into an apparent crash, so the bound cuts it off
// and reports the cause instead of leaving an unhandled rejection.

import { reportError } from "@corbits/error-sink";

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

export type DrainHubServerArgs = {
  whenRequestsIdle: () => Promise<void>;
  stop: (force: boolean) => void | Promise<void>;
  close: () => void | Promise<void>;
};

/**
 * Wait for every in-flight Hono handler to return, then force-stop the
 * listener so lingering SSE/websocket connections cannot hang `server.stop()`,
 * then close hub resources.
 */
export async function drainHubServer({
  whenRequestsIdle,
  stop,
  close,
}: DrainHubServerArgs): Promise<void> {
  await whenRequestsIdle();
  await stop(true);
  await close();
}

export type ShutdownHubDeps = {
  drain: () => Promise<void>;
  timeoutMs: number;
  exit: (code: number) => void;
  report?: typeof reportError;
};

/**
 * Drains the hub within `timeoutMs` and always exits: 0 on a clean drain,
 * non-zero with the cause reported through `reportError` on a throw or a
 * timeout.
 */
export async function shutdownHub({
  drain,
  timeoutMs,
  exit,
  report = reportError,
}: ShutdownHubDeps): Promise<void> {
  const outcome = await drainWithTimeout(drain, timeoutMs);
  if (outcome.kind === "drained") {
    exit(0);
    return;
  }
  const error =
    outcome.kind === "timed-out"
      ? new Error(`Hub shutdown drain exceeded ${timeoutMs}ms`)
      : outcome.error;
  report(error, { operation: "hub.shutdown" });
  exit(1);
}
