import { afterEach, describe, expect, it, mock } from "bun:test";
import {
  coalesceInstanceLaunch,
  resetInstanceLaunchCoalescer,
} from "./instance-launch-coalescer";

afterEach(() => {
  resetInstanceLaunchCoalescer();
});

describe("coalesceInstanceLaunch", () => {
  it("runs one launch for two concurrent calls and resolves both with its result", async () => {
    let resolveLaunch: (value: string) => void = () => {};
    const launch = mock(
      () =>
        new Promise<string>((resolve) => {
          resolveLaunch = resolve;
        }),
    );

    const first = coalesceInstanceLaunch("ins-1", launch);
    const second = coalesceInstanceLaunch("ins-1", launch);

    expect(launch).toHaveBeenCalledTimes(1);

    resolveLaunch("ok");
    const [a, b] = await Promise.all([first, second]);
    expect(a).toBe("ok");
    expect(b).toBe("ok");
  });

  it("launches fresh after the prior launch settles", async () => {
    const launch = mock(() => Promise.resolve("done"));

    await coalesceInstanceLaunch("ins-1", launch);
    await coalesceInstanceLaunch("ins-1", launch);

    expect(launch).toHaveBeenCalledTimes(2);
  });

  it("keeps the in-flight promise keyed per instance", async () => {
    let resolveA: (value: string) => void = () => {};
    const launchA = mock(
      () =>
        new Promise<string>((resolve) => {
          resolveA = resolve;
        }),
    );
    const launchB = mock(() => Promise.resolve("b"));

    const a = coalesceInstanceLaunch("ins-A", launchA);
    await coalesceInstanceLaunch("ins-B", launchB);

    expect(launchA).toHaveBeenCalledTimes(1);
    expect(launchB).toHaveBeenCalledTimes(1);

    resolveA("a");
    expect(await a).toBe("a");
  });

  it("propagates a failed launch to both callers and clears the in-flight entry", async () => {
    const failure = new Error("launch failed");
    let rejectLaunch: (err: Error) => void = () => {};
    const failing = mock(
      () =>
        new Promise<string>((_resolve, reject) => {
          rejectLaunch = reject;
        }),
    );

    const first = coalesceInstanceLaunch("ins-1", failing);
    const second = coalesceInstanceLaunch("ins-1", failing);
    expect(failing).toHaveBeenCalledTimes(1);

    rejectLaunch(failure);
    await expect(first).rejects.toBe(failure);
    await expect(second).rejects.toBe(failure);

    // Entry cleared: a subsequent call launches fresh rather than returning the
    // settled (rejected) promise.
    const retry = mock(() => Promise.resolve("recovered"));
    expect(await coalesceInstanceLaunch("ins-1", retry)).toBe("recovered");
    expect(retry).toHaveBeenCalledTimes(1);
  });
});
