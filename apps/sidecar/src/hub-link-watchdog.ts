// A hub connect attempt that lands while the hub is being replaced can
// dangle forever: no open, no close, so the link never re-schedules a
// reconnect and the sidecar sits disconnected. The watchdog arms a stall
// deadline around every connect attempt and fires `onStall` when neither
// outcome arrives in time; the host exits non-zero so the platform's
// restart policy re-runs the idempotent boot path.

import type { ReconnectScheduler } from "@intx/hub-agent";

export interface HubLinkWatchdog {
  /**
   * Wrap around the link's reconnect scheduling so every scheduled
   * attempt re-arms the stall deadline just before it runs.
   */
  scheduleReconnect: ReconnectScheduler;
  /**
   * Arm the deadline for the first connect attempt, which bypasses the
   * reconnect scheduler.
   */
  armForBoot(): void;
  /**
   * Disarm the deadline. Call from any signal that proves the link made
   * progress (an open handler firing, a close that re-schedules).
   */
  markAlive(): void;
}

export type CreateHubLinkWatchdogOpts = {
  stallDeadlineMs: number;
  onStall: () => void;
};

export function createHubLinkWatchdog(
  opts: CreateHubLinkWatchdogOpts,
): HubLinkWatchdog {
  let deadline: ReturnType<typeof setTimeout> | undefined;

  function arm(): void {
    disarm();
    deadline = setTimeout(opts.onStall, opts.stallDeadlineMs);
  }

  function disarm(): void {
    if (deadline !== undefined) {
      clearTimeout(deadline);
      deadline = undefined;
    }
  }

  return {
    armForBoot: arm,
    markAlive: disarm,
    scheduleReconnect: (callback, delayMs) => {
      const handle = setTimeout(() => {
        arm();
        callback();
      }, delayMs);
      return () => {
        clearTimeout(handle);
      };
    },
  };
}
