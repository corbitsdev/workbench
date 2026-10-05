import { describe, expect, test } from "bun:test";

import { deploymentLiveness, diedQuickly, redeployMode, workerState } from "./deployment-liveness";

describe("deploymentLiveness", () => {
  test("a deployed projection over an errored run is stopped", () => {
    expect(deploymentLiveness("deployed", "error")).toBe("stopped");
  });

  test("a deployed projection over a stopped run is stopped", () => {
    expect(deploymentLiveness("deployed", "stopped")).toBe("stopped");
  });

  test("a deployed projection over a serving run is live", () => {
    expect(deploymentLiveness("deployed", "running")).toBe("live");
    expect(deploymentLiveness("deployed", "deployed")).toBe("live");
    expect(deploymentLiveness("deployed", "updating")).toBe("live");
  });

  test("pending and recovering projections are starting", () => {
    expect(deploymentLiveness("pending", "running")).toBe("starting");
    expect(deploymentLiveness("recovering", "updating")).toBe("starting");
  });

  test("a deployment with no run is judged by its projection alone", () => {
    expect(deploymentLiveness("deployed", undefined)).toBe("live");
  });

  test("terminal projections are stopped", () => {
    for (const status of ["failed", "released", "releasing", "destroy_failed"] as const) {
      expect(deploymentLiveness(status, "running")).toBe("stopped");
    }
  });
});

describe("diedQuickly", () => {
  const run = { createdAt: "2026-10-04T10:00:00.000Z" };

  test("a run that ended seconds after it started died quickly", () => {
    expect(
      diedQuickly({
        ...run,
        updatedAt: "2026-10-04T10:00:20.000Z",
        endedAt: "2026-10-04T10:00:20.000Z",
      }),
    ).toBe(true);
  });

  test("a run that served for an hour before dying did not", () => {
    expect(
      diedQuickly({
        ...run,
        updatedAt: "2026-10-04T11:00:00.000Z",
        endedAt: "2026-10-04T11:00:00.000Z",
      }),
    ).toBe(false);
  });

  test("falls back to updatedAt when endedAt is absent", () => {
    expect(diedQuickly({ ...run, updatedAt: "2026-10-04T10:00:05.000Z" })).toBe(true);
    expect(diedQuickly({ ...run, updatedAt: "2026-10-04T10:30:00.000Z", endedAt: null })).toBe(
      false,
    );
  });
});

describe("2-minute boundary", () => {
  const createdAt = "2026-10-04T10:00:00.000Z";

  test("dying just inside two minutes is quick, at two minutes it is not", () => {
    expect(diedQuickly({ createdAt, updatedAt: "2026-10-04T10:01:59.999Z" })).toBe(true);
    expect(diedQuickly({ createdAt, updatedAt: "2026-10-04T10:02:00.000Z" })).toBe(false);
  });
});

describe("redeployMode and workerState", () => {
  const dead = { liveAddress: null, latest: "stopped", capped: false } as const;

  test("a live agent is left alone", () => {
    const live = { ...dead, liveAddress: "w@bench.example" };
    expect(redeployMode(live)).toBeUndefined();
    expect(workerState(live)).toBe("live");
  });

  test("a coming-up agent is left alone and reads starting", () => {
    const coming = { liveAddress: null, latest: "starting", capped: false } as const;
    expect(redeployMode(coming)).toBeUndefined();
    expect(workerState(coming)).toBe("starting");
  });

  test("a dead agent redeploys on its own and reads starting", () => {
    expect(redeployMode(dead)).toBe("auto");
    expect(workerState(dead)).toBe("starting");
  });

  test("a capped dead agent waits for Restart and reads stopped", () => {
    expect(redeployMode({ ...dead, capped: true })).toBe("manual");
    expect(workerState({ ...dead, capped: true })).toBe("stopped");
  });
});
