import { getLogger } from "@intx/log";

const log = getLogger(["api", "agents", "relaunch-breaker"]);

/**
 * Process-local circuit breaker for the poll-driven Myra auto-relaunch path
 * (`relaunchInstanceIfNeeded`, fired on every `POST /v1/me`). Two failure modes
 * it closes (CL-2407):
 *
 *  - **In-flight dedup**: concurrent `/me` calls land before the first launch
 *    resolves and each fires its own expensive launch. We coalesce them onto a
 *    single in-flight promise keyed per instance.
 *  - **Failure-aware cooldown**: a launch that keeps failing is otherwise
 *    re-attempted on every poll (client-driven, seconds apart), sustaining load
 *    on the shared hub. We record the failure and refuse re-attempts until an
 *    exponential, capped backoff elapses.
 *
 * The hub is the shared resource and the only component that knows a launch
 * just failed, so the durable state lives here. It is process-local (a breaker,
 * not a persisted lock) — a hub restart resets it, which is the correct
 * behaviour: a fresh process should retry once.
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

const inFlight = new Map<string, Promise<void>>();
const failures = new Map<string, FailureState>();

let clock: RelaunchBreakerClock = () => Date.now();

/** Test seam: override the clock so cooldown windows are deterministic. */
export function setRelaunchBreakerClock(next: RelaunchBreakerClock): void {
  clock = next;
}

/** Test seam: drop all breaker state and restore the real clock. */
export function resetRelaunchBreaker(): void {
  inFlight.clear();
  failures.clear();
  clock = () => Date.now();
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
 * Coalesce relaunch attempts for one instance. If a launch is already in flight
 * for `instanceId`, returns the existing promise without invoking `launch`. If
 * the instance is in a failure cooldown, returns without launching. Otherwise
 * runs `launch` once, recording success (clears state) or failure (arms/extends
 * the cooldown). Re-throws the launch error to the caller after recording it,
 * so the HTTP layer still logs the cause — the breaker debounces repeats, it
 * does not swallow faults.
 */
export function runDedupedRelaunch(
  instanceId: string,
  launch: () => Promise<void>,
): Promise<void> {
  const existing = inFlight.get(instanceId);
  if (existing) return existing;

  if (isInRelaunchCooldown(instanceId)) {
    log.debug("Relaunch suppressed during cooldown", { instanceId });
    return Promise.resolve();
  }

  const attempt = trackRelaunch(instanceId, launch);
  inFlight.set(instanceId, attempt);
  return attempt;
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
  } finally {
    inFlight.delete(instanceId);
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
