// CL-7476: since the process provisioner started spawning one sidecar per
// allocation, a freshly launched run's first mail can arrive before that
// sidecar has finished booting and registering with the hub. The send
// fails with "agent is unreachable" even though nothing is actually wrong
// — the address just isn't routable yet. Chat's send/fan-out path, its
// invite first-turn delivery, and the webhook trigger's ingress delivery
// each hit this same race independently; this is the one shared retry
// they all go through instead of three ad hoc copies.
const DEFAULT_DEADLINE_MS = 20_000;
const DEFAULT_POLL_INTERVAL_MS = 250;

export function isAgentUnreachableError(err: unknown): boolean {
  return err instanceof Error && err.message.includes("agent is unreachable");
}

export type DeliverWhenRoutableOptions<T> = {
  /** Performs the actual delivery. Called once, and again after the
   * address becomes routable if the first attempt fails unreachable. */
  send: () => Promise<T>;
  /** Reads the hub's live routing table for this delivery's address. */
  isRoutable: () => boolean;
  /** Defaults to matching Interchange's "agent is unreachable" message. */
  isUnreachable?: (err: unknown) => boolean;
  /** How long to keep polling before giving up. Defaults to a budget a
   * touch past the process provisioner's own boot-and-register time. */
  deadlineMs?: number;
  pollIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
};

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Attempts `send`; if it fails with "agent is unreachable", polls
 * `isRoutable` until the address is routable (or the deadline passes)
 * and sends exactly once more. Any other failure, or an unreachable
 * failure that never resolves before the deadline, is rethrown as-is —
 * this never swallows the original error or retries indefinitely.
 */
export async function deliverWhenRoutable<T>(
  opts: DeliverWhenRoutableOptions<T>,
): Promise<T> {
  const isUnreachable = opts.isUnreachable ?? isAgentUnreachableError;
  try {
    return await opts.send();
  } catch (err) {
    if (!isUnreachable(err)) {
      throw err;
    }
    const deadline = Date.now() + (opts.deadlineMs ?? DEFAULT_DEADLINE_MS);
    const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const sleep = opts.sleep ?? defaultSleep;
    while (!opts.isRoutable()) {
      if (Date.now() >= deadline) {
        throw err;
      }
      await sleep(pollIntervalMs);
    }
    return await opts.send();
  }
}
