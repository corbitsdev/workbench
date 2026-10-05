import { describe, expect, test } from "bun:test";

import { agentsToAutoDeploy, stoppedAgents } from "./agent-redeploy";
import { redeployMode, workerState } from "./deployment-liveness";
import type { WorkbenchParticipant } from "./threads-api";
import { workerStatus } from "../pages/workers-page";

const agent = (over: Partial<WorkbenchParticipant>): WorkbenchParticipant => ({
  id: "a1",
  kind: "agent",
  name: "Worker",
  address: "",
  assetName: "worker",
  ...over,
});

describe("agent redeploy selection", () => {
  test("an agent marked auto is redeployed on its own", () => {
    const released = agent({ redeploy: "auto" });
    expect(agentsToAutoDeploy([released]).map((a) => a.id)).toEqual([released.id]);
    expect(stoppedAgents([released])).toEqual([]);
  });

  test("an agent marked manual waits for Restart", () => {
    const capped = agent({ redeploy: "manual" });
    expect(agentsToAutoDeploy([capped])).toEqual([]);
    expect(stoppedAgents([capped]).map((a) => a.id)).toEqual([capped.id]);
  });

  test("a coming-up or live agent is neither", () => {
    for (const other of [agent({}), agent({ address: "worker@bench.example" })]) {
      expect(agentsToAutoDeploy([other])).toEqual([]);
      expect(stoppedAgents([other])).toEqual([]);
    }
  });
});

describe("workers list and chat agree", () => {
  const shapes = [
    { liveAddress: "w@bench.example", latest: "live", capped: false },
    { liveAddress: null, latest: "starting", capped: false },
    { liveAddress: null, latest: "stopped", capped: false },
    { liveAddress: null, latest: "stopped", capped: true },
  ] as const;

  for (const shape of shapes) {
    test(`${shape.latest} live=${shape.liveAddress !== null} capped=${shape.capped}`, () => {
      const stopped = redeployMode(shape) === "manual";
      expect(workerStatus(shape).tone === "ready").toBe(stopped);
      expect(workerState(shape) === "stopped").toBe(stopped);
    });
  }
});
