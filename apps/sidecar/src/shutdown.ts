// Bounded drain for process shutdown. The platform sends SIGTERM and
// expects a prompt exit; a drain that hangs would turn every deploy into
// an apparent crash, so the bound cuts it off. Timing out is not a
// fault -- the process is exiting either way -- but a drain that throws
// is, and the two outcomes are kept distinct so the caller can exit
// non-zero only for the genuine failure.
//
// `runSidecarShutdown` is the SIGTERM/SIGINT body: close, then drain.
// Throws from either (including a sync throw from orchestrator.close)
// become process.exit(1) rather than an unhandled rejection.
// `attachShutdownRejectionHandler` is the belt on the signal listener
// itself so a rejection that still escapes that body cannot become an
// unhandledRejection.

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

export type SidecarShutdownLog = {
  info(strings: TemplateStringsArray, ...values: unknown[]): void;
  error(strings: TemplateStringsArray, ...values: unknown[]): void;
};

export type RunSidecarShutdownArgs = {
  signal: string;
  close: () => void;
  drain: () => Promise<void>;
  drainTimeoutMs: number;
  exit: (code: number) => void;
  log: SidecarShutdownLog;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function runSidecarShutdown(
  args: RunSidecarShutdownArgs,
): Promise<void> {
  args.log.info`Received ${args.signal}; draining before exit`;
  try {
    args.close();
    const outcome = await drainWithTimeout(args.drain, args.drainTimeoutMs);
    // Drained and timed-out both exit 0: the process is going down either
    // way and a bound cutting a slow drain short is not a crash. A drain
    // that threw is a genuine fault and exits non-zero.
    if (outcome.kind === "failed") {
      args.log
        .error`Drain threw during shutdown; exiting non-zero: ${errorMessage(outcome.error)}`;
      args.exit(1);
      return;
    }
    args.exit(0);
  } catch (error) {
    reportError(error, { operation: "sidecar.shutdown" });
    args.log.error`Shutdown threw; exiting non-zero: ${errorMessage(error)}`;
    args.exit(1);
  }
}

export function attachShutdownRejectionHandler(
  work: Promise<void>,
  onRejection: (error: unknown) => void,
): void {
  void work.catch(onRejection);
}
