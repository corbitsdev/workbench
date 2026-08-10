import { describe, expect, test } from "bun:test";

import type { WorkflowRun } from "./api";
import {
  INSIGHTS_RUNS_PATH,
  runDeepLinkTarget,
  runDetailPath,
} from "./insights-deeplinks";

function run(id: string): WorkflowRun {
  return {
    id,
    tenantId: "t1",
    tenantName: "Bench",
    definitionId: "def",
    definitionName: "research-brief",
    address: "addr",
    status: "running",
    createdAt: "2026-01-02T00:00:00.000Z",
  };
}

describe("runDetailPath", () => {
  test("builds the /insights/runs/:id path", () => {
    expect(runDetailPath("run_123")).toBe(`${INSIGHTS_RUNS_PATH}/run_123`);
  });

  test("encodes ids so a slash or space cannot break out of the segment", () => {
    expect(runDetailPath("a/b c")).toBe(`${INSIGHTS_RUNS_PATH}/a%2Fb%20c`);
  });
});

describe("runDeepLinkTarget", () => {
  test("returns the insights run-detail path for a purpose run", () => {
    expect(runDeepLinkTarget(run("run_42"))).toBe(
      `${INSIGHTS_RUNS_PATH}/run_42`,
    );
  });

  test("is stable across two runs that differ only by id", () => {
    expect(runDeepLinkTarget(run("a"))).not.toBe(runDeepLinkTarget(run("b")));
  });
});
