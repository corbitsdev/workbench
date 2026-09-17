// The emitter's own logic worth proving: a tick re-arms after it fires,
// at the next instant after the tick that ran — never at the one it just
// ran, and never at a tick that fell during a slow fire.
import { describe, expect, test } from "bun:test";

import {
  createCronEmitter,
  timerIdForTick,
  type CronDeployment,
} from "./emitter";

const deployment: CronDeployment = {
  deploymentId: "def_digest",
  cron: "* * * * *",
};

describe("createCronEmitter re-arm", () => {
  test("re-arms at the tick after the one that fired, skipping ticks a slow fire ran through", async () => {
    // 20ms before the tick, so the armed `setTimeout` really elapses.
    let now = new Date("2026-01-01T09:00:59.980Z");
    const fired: string[] = [];
    const emitter = createCronEmitter({
      listCronDeployments: () => Promise.resolve([deployment]),
      fire: (_deployment, tick) => {
        fired.push(tick.fireAt);
        // The fire takes three minutes of wall clock.
        now = new Date("2026-01-01T09:04:10.000Z");
        return Promise.resolve();
      },
      onError: (error) => {
        throw error;
      },
      clock: () => now,
      rescanIntervalMs: 60_000,
    });

    await emitter.rescan();
    expect(emitter.armed()).toEqual([
      {
        deploymentId: "def_digest",
        tick: {
          timerId: timerIdForTick(
            "def_digest",
            new Date("2026-01-01T09:01:00.000Z"),
          ),
          fireAt: "2026-01-01T09:01:00.000Z",
          cron: "* * * * *",
        },
      },
    ]);

    await Bun.sleep(40);
    expect(fired).toEqual(["2026-01-01T09:01:00.000Z"]);
    // Re-armed strictly after the slow fire's end, not at 09:02 (a tick
    // that already passed — the scheduler seam drops a past-due cron
    // TimerSet, so arming one would stall the schedule for good).
    expect(emitter.armed()[0]?.tick.fireAt).toBe("2026-01-01T09:05:00.000Z");
    emitter.stop();
  });

  test("a second rescan does not re-arm an already-armed tick", async () => {
    const now = new Date("2026-01-01T09:00:30.000Z");
    const emitter = createCronEmitter({
      listCronDeployments: () => Promise.resolve([deployment]),
      fire: () => Promise.resolve(),
      onError: (error) => {
        throw error;
      },
      clock: () => now,
      rescanIntervalMs: 60_000,
    });
    await emitter.rescan();
    const first = emitter.armed()[0]?.tick.timerId;
    await emitter.rescan();
    expect(emitter.armed()).toHaveLength(1);
    expect(emitter.armed()[0]?.tick.timerId).toBe(first);
    emitter.stop();
  });

  test("a deployment that left the list is disarmed", async () => {
    const now = new Date("2026-01-01T09:00:30.000Z");
    let listed: readonly CronDeployment[] = [deployment];
    const emitter = createCronEmitter({
      listCronDeployments: () => Promise.resolve(listed),
      fire: () => Promise.resolve(),
      onError: (error) => {
        throw error;
      },
      clock: () => now,
      rescanIntervalMs: 60_000,
    });
    await emitter.rescan();
    expect(emitter.armed()).toHaveLength(1);
    listed = [];
    await emitter.rescan();
    expect(emitter.armed()).toHaveLength(0);
    emitter.stop();
  });
});
