import { getLogger } from "@intx/log";
import {
  coalesceInstanceLaunch,
  resetInstanceLaunchCoalescer,
} from "./instance-launch-coalescer";

const log = getLogger(["api", "agents", "relaunch-breaker"]);

/**
 * Failure-aware cooldown decorator over the shared per-instance launch
 * coalescer (`coalesceInstanceLaunch`). This is the wedge-sweep / poll-driven
 * relaunch entry point (`relaunchInstanceIfNeeded`); it adds a backoff on top
 * of the one in-flight primitive so a launch that keeps failing is not
 * re-attempted on every poll (client-driven, seconds apart), sustaining load on
 * the shared hub. In-flight dedup is NOT owned here — it lives in
 * `coalesceInstanceLaunch`, so a sweep relaunch and an explicit
 * `POST /instances/:id/sessions` for the same instance coalesce onto one launch
 * (CL-2407, CL-3152).
 *
 * The hub is the shared resource and the only component that knows a launch
 * just failed, so the durable cooldown state lives here. It is process-local (a
 * breaker, not a persisted lock) — a hub restart resets it, which is the
 * correct behaviour: a fresh process should retry once.
 */

// Backoff schedule: the `/me` poll cadence is client-driven and only seconds
// apart, so even a short cooldown collapses the storm. Start at 30s, double on
// each consecutive failure, cap at 5 min. A successful launch clears the entry,
// so the schedule only ever climbs while launches keep failing.
const BASE_COOLDOWN_MS = 30_000;
const MAX_COOLDOWN_MS = 300_000;

export type RelaunchBreakerClock = () => number;

type FailureState = {
  // Wall-clock ms after which a re-attempt is allowed again.
  cooldownUntil: number;
  // Consecutive failure count, used to grow the backoff exponentially.
  consecutiveFailures: number;
};

const failures = new Map<string, FailureState>();

let clock: RelaunchBreakerClock = () => Date.now();

/** Test seam: override the clock so cooldown windows are deterministic. */
export function setRelaunchBreakerClock(next: RelaunchBreakerClock): void {
  clock = next;
}

/** Test seam: drop all breaker state and restore the real clock. */
export function resetRelaunchBreaker(): void {
  failures.clear();
  clock = () => Date.now();
  resetInstanceLaunchCoalescer();
}

function cooldownForFailureCount(consecutiveFailures: number): number {
  const exponent = Math.max(0, consecutiveFailures - 1);
  const scaled = BASE_COOLDOWN_MS * 2 ** exponent;
  return Math.min(scaled, MAX_COOLDOWN_MS);
}

/**
 * True while `instanceId` is inside its post-failure cooldown window. Callers
 * (the relaunch path and the sync assessment) must skip a relaunch while this
 * holds so the client's sync gate stops re-firing.
 */
export function isInRelaunchCooldown(instanceId: string): boolean {
  const state = failures.get(instanceId);
  if (!state) return false;
  if (clock() >= state.cooldownUntil) return false;
  return true;
}

/**
 * Relaunch one instance through the shared launch coalescer, gated by the
 * failure cooldown. If the instance is in a failure cooldown, returns without
 * launching. Otherwise delegates to `coalesceInstanceLaunch` — so a launch
 * already in flight for `instanceId` (from this path or the explicit route) is
 * joined rather than duplicated — and records success (clears cooldown state)
 * or failure (arms/extends the cooldown) for the launch it starts. Re-throws
 * the launch error to the caller after recording it, so the HTTP layer still
 * logs the cause — the breaker debounces repeats, it does not swallow faults.
 */
export function runDedupedRelaunch(
  instanceId: string,
  launch: () => Promise<void>,
): Promise<void> {
  if (isInRelaunchCooldown(instanceId)) {
    log.debug("Relaunch suppressed during cooldown", { instanceId });
    return Promise.resolve();
  }

  return coalesceInstanceLaunch(instanceId, () =>
    trackRelaunch(instanceId, launch),
  );
}

async function trackRelaunch(
  instanceId: string,
  launch: () => Promise<void>,
): Promise<void> {
  try {
    await launch();
    failures.delete(instanceId);
  } catch (err) {
    recordFailure(instanceId);
    throw err;
  }
}

function recordFailure(instanceId: string): void {
  const prior = failures.get(instanceId);
  const consecutiveFailures = (prior?.consecutiveFailures ?? 0) + 1;
  const cooldownMs = cooldownForFailureCount(consecutiveFailures);
  const cooldownUntil = clock() + cooldownMs;
  failures.set(instanceId, { cooldownUntil, consecutiveFailures });
  log.warn("Relaunch failed; arming cooldown", {
    instanceId,
    consecutiveFailures,
    cooldownMs,
  });
}
