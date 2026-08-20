// Proves each gate `createAgentLifecycle`'s sweep applies, in order,
// and that `ensureAwake` coalesces concurrent wakes for the same
// address into a single call to the injected `wake`. The sweep itself
// is driven directly (no `setInterval` involved) by reaching into the
// module's internals is avoided; instead these tests configure a short
// `sweepIntervalMs` and await one real tick, since the gates are the
// contract under test, not the timer plumbing.
import { afterEach, describe, expect, test } from "bun:test";
import { getLogger } from "@intx/log";
import {
  createAgentLifecycle,
  IDLE_HIBERNATE_UNDEPLOY_REASON,
} from "../src/index";

const log = getLogger(["chat", "lifecycle", "test"]);

function waitForTicks(count = 1): Promise<void> {
  return new Promise((resolve) => {
    let remaining = count;
    const tick = () => {
      remaining -= 1;
      if (remaining <= 0) {
        resolve();
      } else {
        setTimeout(tick, 5);
      }
    };
    setTimeout(tick, 5);
  });
}

describe("createAgentLifecycle", () => {
  let stop: (() => void) | undefined;
  afterEach(() => {
    stop?.();
    stop = undefined;
  });

  test("sleeps a tracked, routable, idle instance", async () => {
    const undeployCalls: { address: string; reason: string }[] = [];
    const routable = new Set(["agent-1@t.test"]);

    const lifecycle = createAgentLifecycle({
      idleSleepMs: 10,
      sweepIntervalMs: 5,
      isRoutable: (address) => routable.has(address),
      undeploy: async (address, reason) => {
        undeployCalls.push({ address, reason });
        // Mirrors reality: once undeployed, the host no longer
        // reports the address as routable, so a second sweep tick
        // must not undeploy it again.
        routable.delete(address);
      },
      wake: async () => undefined,
      log,
    });
    stop = lifecycle.stop;

    lifecycle.track("agent-1@t.test");
    lifecycle.recordActivity("agent-1@t.test");

    // First sweep tick happens quickly (sweepIntervalMs=5) but the
    // instance is not idle for the full 10ms yet.
    await waitForTicks(1);
    expect(undeployCalls).toEqual([]);

    // Wait past idleSleepMs and let another sweep tick run.
    await new Promise((resolve) => setTimeout(resolve, 15));
    await waitForTicks(1);

    expect(undeployCalls).toEqual([
      { address: "agent-1@t.test", reason: IDLE_HIBERNATE_UNDEPLOY_REASON },
    ]);
  });

  test("spares an active instance", async () => {
    const undeployCalls: { address: string; reason: string }[] = [];
    const routable = new Set(["agent-1@t.test"]);

    const lifecycle = createAgentLifecycle({
      idleSleepMs: 1_000,
      sweepIntervalMs: 5,
      isRoutable: (address) => routable.has(address),
      undeploy: async (address, reason) => {
        undeployCalls.push({ address, reason });
      },
      wake: async () => undefined,
      log,
    });
    stop = lifecycle.stop;

    lifecycle.track("agent-1@t.test");
    lifecycle.recordActivity("agent-1@t.test");

    await waitForTicks(3);
    expect(undeployCalls).toEqual([]);
  });

  test("spares a busy instance even when idle past the threshold", async () => {
    const undeployCalls: { address: string; reason: string }[] = [];
    const routable = new Set(["agent-1@t.test"]);

    const lifecycle = createAgentLifecycle({
      idleSleepMs: 10,
      sweepIntervalMs: 5,
      isRoutable: (address) => routable.has(address),
      undeploy: async (address, reason) => {
        undeployCalls.push({ address, reason });
      },
      wake: async () => undefined,
      isBusy: (address) => address === "agent-1@t.test",
      log,
    });
    stop = lifecycle.stop;

    lifecycle.track("agent-1@t.test");
    lifecycle.recordActivity("agent-1@t.test");

    await new Promise((resolve) => setTimeout(resolve, 15));
    await waitForTicks(1);

    expect(undeployCalls).toEqual([]);
  });

  test("never sleeps an untracked instance", async () => {
    const undeployCalls: { address: string; reason: string }[] = [];
    const routable = new Set(["agent-1@t.test"]);

    const lifecycle = createAgentLifecycle({
      idleSleepMs: 10,
      sweepIntervalMs: 5,
      isRoutable: (address) => routable.has(address),
      undeploy: async (address, reason) => {
        undeployCalls.push({ address, reason });
      },
      wake: async () => undefined,
      log,
    });
    stop = lifecycle.stop;

    // Never tracked -- recordActivity alone must not be enough to be
    // swept.
    lifecycle.recordActivity("agent-1@t.test");

    await new Promise((resolve) => setTimeout(resolve, 15));
    await waitForTicks(1);

    expect(undeployCalls).toEqual([]);
  });

  test("a freshly tracked instance gets one sweep's grace before its idle clock counts", async () => {
    const undeployCalls: { address: string; reason: string }[] = [];
    const routable = new Set(["agent-1@t.test"]);

    const lifecycle = createAgentLifecycle({
      idleSleepMs: 10,
      sweepIntervalMs: 5,
      isRoutable: (address) => routable.has(address),
      undeploy: async (address, reason) => {
        undeployCalls.push({ address, reason });
        routable.delete(address);
      },
      wake: async () => undefined,
      log,
    });
    stop = lifecycle.stop;

    // Tracked with no recordActivity -- as if rehydrated after a
    // restart, with no activity observed yet in this process.
    lifecycle.track("agent-1@t.test");

    // The very first sweep must seed the clock, not sleep immediately.
    await waitForTicks(1);
    expect(undeployCalls).toEqual([]);

    // Only after the grace-seeded clock itself goes idle does it sleep.
    await new Promise((resolve) => setTimeout(resolve, 15));
    await waitForTicks(1);
    expect(undeployCalls).toEqual([
      { address: "agent-1@t.test", reason: IDLE_HIBERNATE_UNDEPLOY_REASON },
    ]);
  });

  test("untracked or non-routable instances are skipped even when idle", async () => {
    const undeployCalls: { address: string; reason: string }[] = [];
    const routable = new Set<string>();

    const lifecycle = createAgentLifecycle({
      idleSleepMs: 10,
      sweepIntervalMs: 5,
      isRoutable: (address) => routable.has(address),
      undeploy: async (address, reason) => {
        undeployCalls.push({ address, reason });
      },
      wake: async () => undefined,
      log,
    });
    stop = lifecycle.stop;

    lifecycle.track("agent-1@t.test");
    lifecycle.recordActivity("agent-1@t.test");

    await new Promise((resolve) => setTimeout(resolve, 15));
    await waitForTicks(1);

    expect(undeployCalls).toEqual([]);
  });

  test("a sweep tick that blocks on undeploy is not re-entered by the next tick", async () => {
    const undeployCalls: string[] = [];
    const routable = new Set(["agent-1@t.test"]);
    let releaseUndeploy: (() => void) | undefined;
    let concurrentUndeploys = 0;
    let maxConcurrentUndeploys = 0;

    const lifecycle = createAgentLifecycle({
      idleSleepMs: 10,
      sweepIntervalMs: 5,
      isRoutable: (address) => routable.has(address),
      undeploy: async (address) => {
        concurrentUndeploys += 1;
        maxConcurrentUndeploys = Math.max(
          maxConcurrentUndeploys,
          concurrentUndeploys,
        );
        undeployCalls.push(address);
        await new Promise<void>((resolve) => {
          releaseUndeploy = resolve;
        });
        concurrentUndeploys -= 1;
        routable.delete(address);
      },
      wake: async () => undefined,
      log,
    });
    stop = lifecycle.stop;

    lifecycle.track("agent-1@t.test");
    lifecycle.recordActivity("agent-1@t.test");

    // Let the address go idle, then let several sweepIntervalMs ticks
    // land while the first sweep's undeploy is still pending. If ticks
    // overlapped, this would call undeploy on the same address a
    // second time before the first has resolved.
    await new Promise((resolve) => setTimeout(resolve, 15));
    await waitForTicks(1);
    expect(undeployCalls).toEqual(["agent-1@t.test"]);

    await waitForTicks(5);
    expect(undeployCalls).toEqual(["agent-1@t.test"]);
    expect(maxConcurrentUndeploys).toBe(1);

    releaseUndeploy?.();
    await new Promise((resolve) => setTimeout(resolve, 5));
  });

  test("ensureAwake no-ops when already routable", async () => {
    const wakeCalls: string[] = [];
    const routable = new Set(["agent-1@t.test"]);

    const lifecycle = createAgentLifecycle({
      idleSleepMs: 1_000,
      isRoutable: (address) => routable.has(address),
      undeploy: async () => undefined,
      wake: async (address) => {
        wakeCalls.push(address);
      },
      log,
    });
    stop = lifecycle.stop;

    await lifecycle.ensureAwake("agent-1@t.test");
    expect(wakeCalls).toEqual([]);
  });

  test("ensureAwake wakes a non-routable instance and coalesces concurrent callers", async () => {
    const wakeCalls: string[] = [];
    const routable = new Set<string>();
    let resolveWake: (() => void) | undefined;

    const lifecycle = createAgentLifecycle({
      idleSleepMs: 1_000,
      isRoutable: (address) => routable.has(address),
      undeploy: async () => undefined,
      wake: async (address) => {
        wakeCalls.push(address);
        await new Promise<void>((resolve) => {
          resolveWake = resolve;
        });
      },
      log,
    });
    stop = lifecycle.stop;

    const first = lifecycle.ensureAwake("agent-1@t.test");
    const second = lifecycle.ensureAwake("agent-1@t.test");

    // Give both calls a tick to have entered `ensureAwake` and observed
    // the same pending wake.
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(wakeCalls).toEqual(["agent-1@t.test"]);

    resolveWake?.();
    await Promise.all([first, second]);

    expect(wakeCalls).toEqual(["agent-1@t.test"]);
  });

  test("ensureAwake propagates a wake failure", async () => {
    const routable = new Set<string>();
    const failure = new Error("sidecar unreachable");

    const lifecycle = createAgentLifecycle({
      idleSleepMs: 1_000,
      isRoutable: (address) => routable.has(address),
      undeploy: async () => undefined,
      wake: async () => {
        throw failure;
      },
      log,
    });
    stop = lifecycle.stop;

    await expect(lifecycle.ensureAwake("agent-1@t.test")).rejects.toThrow(
      failure,
    );
  });
});
