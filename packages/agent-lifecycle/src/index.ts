// A host-agnostic idle-sleep/wake-on-mail scheduler for launched agent
// instances. `createAgentLifecycle` owns two things: a periodic sweep
// that tears down addresses idle past `idleSleepMs`, and `ensureAwake`,
// which redeploys an address on demand and coalesces concurrent callers
// onto one in-flight wake. Every side effect that touches a real
// host — whether an address is currently deployed, tearing one down,
// redeploying one, whether one is mid-turn — arrives as an injected
// port; this package never imports a hub, a sidecar, or
// `@corbits/chat`. A caller wires its own
// `isRoutable`/`undeploy`/`wake` closures in, Scout-style, exactly as
// `packages/chat`'s adapter does.
import type { getLogger } from "@intx/log";

type Logger = ReturnType<typeof getLogger>;

/**
 * The `reason` this package's sweep passes to `undeploy` for every idle
 * eviction. A host's `undeploy` port (e.g. the sidecar's `agent.undeploy`
 * handler) matches on this exact string to choose a STATE-PRESERVING
 * teardown (keep the deployment record, step-state scratch, and slug so a
 * later relaunch resumes the same run) rather than the destructive default
 * a caller-initiated undeploy (channel deletion, member removal, ...) gets.
 * Exported so every `undeploy` port this package's sweep calls can agree on
 * the same tag without each host inventing its own string.
 */
export const IDLE_HIBERNATE_UNDEPLOY_REASON = "idle-hibernate";

export type CreateAgentLifecycleOptions = {
  /** How long an address may sit idle (no `recordActivity`) before the sweep sleeps it. Required — no default hidden in here. */
  idleSleepMs: number;
  /** How often the sweep runs. Defaults to half the sleep threshold, floored at 5s. */
  sweepIntervalMs?: number;
  /** Whether the host currently has this address deployed/connected. */
  isRoutable(address: string): boolean;
  /** Tears the address down on the host. Errors are the caller's to throw; the sweep catches and logs them per-address. */
  undeploy(address: string, reason: string): Promise<void>;
  /** Redeploys the address at head. Errors propagate to `ensureAwake`'s caller. */
  wake(address: string): Promise<void>;
  /** Optional in-flight-turn guard: an address the sweep must never sleep out from under itself. Defaults to never-busy. */
  isBusy?(address: string): boolean;
  log: Logger;
};

export type AgentLifecycle = {
  /** Marks an address as tracked by the sweep. Idempotent. */
  track(address: string): void;
  /** Stops tracking an address; the sweep will never sleep it again. */
  untrack(address: string): void;
  /** Bumps an address's last-activity clock to now. */
  recordActivity(address: string): void;
  /**
   * No-ops when the address is already routable. Otherwise calls the
   * injected `wake` and resolves once it settles; concurrent callers
   * for the same address coalesce onto the one in-flight wake rather
   * than each redeploying it.
   */
  ensureAwake(address: string): Promise<void>;
  /** Stops the sweep interval. Safe to call more than once. */
  stop(): void;
};

/**
 * Composes the idle-sleep sweep and wake-on-mail coalescing described
 * above. The sweep only ever considers `track`ed addresses, and sleeps
 * one only when every gate agrees, in this order: it is currently
 * routable (nothing to sleep otherwise); it has been seen before (a
 * freshly tracked address gets one sweep's grace before its idle clock
 * counts against it — the restart case, where nothing has recorded
 * activity yet but the address may have been deployed for a while);
 * it has actually been idle for `idleSleepMs`; and it is not
 * `isBusy`.
 */
export function createAgentLifecycle(
  options: CreateAgentLifecycleOptions,
): AgentLifecycle {
  const { idleSleepMs, isRoutable, undeploy, wake, log } = options;
  const sweepIntervalMs =
    options.sweepIntervalMs ?? Math.max(idleSleepMs / 2, 5_000);
  const isBusy = options.isBusy ?? (() => false);

  const tracked = new Set<string>();
  const lastActivityMs = new Map<string, number>();
  const pendingWakes = new Map<string, Promise<void>>();

  function track(address: string): void {
    tracked.add(address);
  }

  function untrack(address: string): void {
    tracked.delete(address);
    lastActivityMs.delete(address);
  }

  function recordActivity(address: string): void {
    lastActivityMs.set(address, Date.now());
  }

  async function sweepOnce(): Promise<void> {
    const now = Date.now();
    for (const address of tracked) {
      if (!isRoutable(address)) continue;

      const last = lastActivityMs.get(address);
      if (last === undefined) {
        // First sighting: seed the clock rather than sleeping
        // immediately. Without this grace, an address that has been
        // deployed since before this process started (a restart) would
        // read as infinitely idle and sleep on the very first sweep.
        lastActivityMs.set(address, now);
        continue;
      }

      if (now - last < idleSleepMs) continue;
      if (isBusy(address)) continue;

      try {
        await undeploy(address, IDLE_HIBERNATE_UNDEPLOY_REASON);
        log.info`sleeping idle instance ${address} after ${String(idleSleepMs)}ms of inactivity`;
      } catch (err) {
        log.error`lifecycle sweep failed to undeploy ${address}: ${
          err instanceof Error ? err.message : String(err)
        }`;
      }
    }
  }

  let sweepInFlight = false;

  async function sweepTick(): Promise<void> {
    // A slow `undeploy` can outlive a single sweepIntervalMs tick.
    // Without this guard, the next tick would start a second sweep
    // over the same tracked addresses while the first is still
    // awaiting its undeploys, double-undeploying whatever the first
    // sweep hasn't gotten to yet. Ticks that land while a sweep is
    // still running are dropped; the next one after it finishes picks
    // up wherever state has landed.
    if (sweepInFlight) return;
    sweepInFlight = true;
    try {
      await sweepOnce();
    } finally {
      sweepInFlight = false;
    }
  }

  const interval = setInterval(() => {
    void sweepTick();
  }, sweepIntervalMs);
  if (typeof interval.unref === "function") interval.unref();

  async function ensureAwake(address: string): Promise<void> {
    if (isRoutable(address)) return;

    const pending = pendingWakes.get(address);
    if (pending !== undefined) return pending;

    const waking = wake(address)
      .then(() => {
        recordActivity(address);
      })
      .finally(() => {
        pendingWakes.delete(address);
      });
    pendingWakes.set(address, waking);
    return waking;
  }

  function stop(): void {
    clearInterval(interval);
  }

  return { track, untrack, recordActivity, ensureAwake, stop };
}
