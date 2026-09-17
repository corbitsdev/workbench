// The cron emitter: the half of a schedule-triggered deployment that owns
// the clock. `armCronTimer` says which instant the next tick falls on; this
// module holds that tick, fires it, and re-arms from the instant it fired.
//
// Why the fire is a trigger and not a `TimerFired` read off the scheduler
// seam: the seam (`vendor/intx/workflow-host/src/seams/scheduler.ts`) is
// constructed per workflow-run child, scoped to that child's own run repo
// (`apps/sidecar/src/workflow-substrate-factory/index.ts` builds it with
// `listActiveDeployments: () => [workflowRunRepoId]`), and the supervisor
// is the sole writer of that ref. A `TimerFired` there unblocks a
// `waitForTimer` inside a run that is already executing; it cannot start a
// fresh one, and a definition cannot re-arm its own cron (`sleep` is
// literal-only and banned in loops). So a tick that must launch a run fires
// through the deployment's own native trigger, which the caller supplies as
// `fire`.
//
// A tick's identity is derived, never minted: `timerIdForTick` is a pure
// function of the deployment id and the tick's instant, so two emitters
// arming the same tick name it the same thing and a sink that dedupes on
// timer identity collapses them.
import { armCronTimer, type CronTimerSet } from "./timer";

export type CronDeployment = {
  readonly deploymentId: string;
  /** The definition's `ScheduleTrigger.cron`, 5-field. */
  readonly cron: string;
  /** IANA zone the expression is read in; the instant is always UTC. */
  readonly timeZone?: string;
};

export type CronEmitterDeps<D extends CronDeployment = CronDeployment> = {
  /**
   * Every deployment whose definition carries a `ScheduleTrigger`, as of
   * now. Re-read on each rescan, so a deploy, an undeploy, or a cron edit
   * takes effect without a restart.
   */
  readonly listCronDeployments: () => Promise<readonly D[]>;
  /**
   * Fire one tick. Called once per armed tick; a throw is reported by the
   * caller's `onError` and the schedule re-arms regardless, so a single bad
   * tick never stalls the cadence.
   */
  readonly fire: (deployment: D, tick: CronTimerSet) => Promise<void>;
  readonly onError: (error: unknown, deployment: D | CronDeployment) => void;
  readonly clock: () => Date;
  /** How often the deployment list is re-read. */
  readonly rescanIntervalMs?: number;
};

export type CronEmitterHandle<D extends CronDeployment = CronDeployment> = {
  /** Read the deployment list and arm every deployment's next tick. */
  rescan(): Promise<void>;
  /** Currently armed ticks, one per deployment. Tests assert on this. */
  armed(): readonly { deploymentId: string; tick: CronTimerSet }[];
  /** The deployment armed for `deploymentId`, if any. */
  armedDeployment(deploymentId: string): D | undefined;
  stop(): void;
};

export const DEFAULT_CRON_RESCAN_INTERVAL_MS = 60_000;

/**
 * The identity of the tick `deploymentId` fires at `fireAt`. Deterministic:
 * the same deployment and the same instant always name the same tick.
 */
export function timerIdForTick(deploymentId: string, fireAt: Date): string {
  return `cron:${deploymentId}:${fireAt.toISOString()}`;
}

type ArmedTick<D extends CronDeployment> = {
  deployment: D;
  tick: CronTimerSet;
  timeout: ReturnType<typeof setTimeout>;
};

export function createCronEmitter<D extends CronDeployment = CronDeployment>(
  deps: CronEmitterDeps<D>,
): CronEmitterHandle<D> {
  const armedTicks = new Map<string, ArmedTick<D>>();
  let stopped = false;

  function arm(deployment: D, firedAt?: Date): void {
    if (stopped) return;
    const now = deps.clock();
    let tick: CronTimerSet;
    try {
      tick = armCronTimer({
        cron: deployment.cron,
        now,
        ...(firedAt !== undefined ? { firedAt } : {}),
        ...(deployment.timeZone !== undefined
          ? { timeZone: deployment.timeZone }
          : {}),
        newTimerId: (fireAt) => timerIdForTick(deployment.deploymentId, fireAt),
      });
    } catch (error) {
      // report-error-ignore: this package takes no dependency on
      // @corbits/error-sink so it stays publishable and host-agnostic;
      // `onError` is the reporting seam and the hub wires `reportError`
      // straight into it.
      deps.onError(error, deployment);
      return;
    }
    const existing = armedTicks.get(deployment.deploymentId);
    if (existing !== undefined) {
      if (existing.tick.timerId === tick.timerId) return;
      clearTimeout(existing.timeout);
    }
    const armedTick: ArmedTick<D> = {
      deployment,
      tick,
      timeout: setTimeout(
        () => {
          void fireTick(deployment.deploymentId);
        },
        Math.max(0, Date.parse(tick.fireAt) - now.getTime()),
      ),
    };
    if (typeof armedTick.timeout.unref === "function") {
      armedTick.timeout.unref();
    }
    armedTicks.set(deployment.deploymentId, armedTick);
  }

  async function fireTick(deploymentId: string): Promise<void> {
    const entry = armedTicks.get(deploymentId);
    if (entry === undefined || stopped) return;
    armedTicks.delete(deploymentId);
    const firedAt = new Date(entry.tick.fireAt);
    try {
      await deps.fire(entry.deployment, entry.tick);
    } catch (error) {
      // report-error-ignore: reported through the caller's `onError`, which
      // the hub wires to `reportError` — see the sibling catch in `arm`.
      deps.onError(error, entry.deployment);
    }
    // Re-arm from the tick's own instant, not from `now`: a fire observed
    // late must still land on the next tick after the one it just ran,
    // and `armCronTimer` skips whatever fell in between rather than
    // replaying it.
    arm(entry.deployment, firedAt);
  }

  async function rescan(): Promise<void> {
    const deployments = await deps.listCronDeployments();
    const live = new Set<string>();
    for (const deployment of deployments) {
      live.add(deployment.deploymentId);
      arm(deployment);
    }
    for (const [deploymentId, entry] of armedTicks) {
      if (live.has(deploymentId)) continue;
      clearTimeout(entry.timeout);
      armedTicks.delete(deploymentId);
    }
  }

  const rescanInterval = setInterval(() => {
    void rescan().catch((error: unknown) => {
      deps.onError(error, { deploymentId: "*", cron: "*" });
    });
  }, deps.rescanIntervalMs ?? DEFAULT_CRON_RESCAN_INTERVAL_MS);
  if (typeof rescanInterval.unref === "function") rescanInterval.unref();

  return {
    rescan,
    armedDeployment(deploymentId) {
      return armedTicks.get(deploymentId)?.deployment;
    },
    armed() {
      return [...armedTicks.values()].map((entry) => ({
        deploymentId: entry.deployment.deploymentId,
        tick: entry.tick,
      }));
    },
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(rescanInterval);
      for (const entry of armedTicks.values()) clearTimeout(entry.timeout);
      armedTicks.clear();
    },
  };
}
